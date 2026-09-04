import cookie from '@fastify/cookie';
import {
  AcceptPendingDeviceRequestSchema,
  AcceptPendingFolderRequestSchema,
  AuthStatusSchema,
  CreateDeviceRequestSchema,
  CreateFolderRequestSchema,
  DirectoryQuerySchema,
  FolderIdSchema,
  FolderFilesQuerySchema,
  LoginRequestSchema,
  OpenTokenLoginRequestSchema,
  RestoreVersionsRequestSchema,
  RevealFileRequestSchema,
  SetupRequestSchema,
  UpdateDeviceRequestSchema,
  UpdateFolderRequestSchema,
  UpdateNodeSettingsSchema,
  type AcceptPendingDeviceRequest,
  type AcceptPendingFolderRequest,
  type CreateDeviceRequest,
  type CreateFolderRequest,
  type Device,
  type DirectoryQuery,
  type Folder,
  type FolderFilesQuery,
  type FolderState,
  type LoginRequest,
  type NodeInfo,
  type NodeSettings,
  type OpenTokenLoginRequest,
  type RestoreVersionsRequest,
  type RevealFileRequest,
  type SetupRequest,
  type UpdateFolderRequest,
  type UpdateDeviceRequest,
  type UpdateNodeSettings,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';
import { BlockList, isIP } from 'node:net';
import { basename, extname, posix, resolve, sep } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { NodeConfig } from './config.js';
import { DirectoryBrowser, isWithinRoot } from './directory-browser.js';
import { embeddedWebAssets } from './embedded-web-assets.js';
import { FolderFiles, safeRelativePath } from './folder-files.js';
import type { StateStore, StoredNodeSettings } from './state-store.js';
import {
  LocalSyncthing,
  type SyncthingDeviceConfig,
  type SyncthingFolderConfig,
} from './syncthing.js';

const SESSION_COOKIE = 'kitesync_session';
const SESSION_TTL_MS = 12 * 60 * 60_000;
const OPEN_TOKEN_TTL_MS = 30_000;
const DEVICE_ID_PATTERN = /^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/;

interface Session {
  csrfToken: string;
  expiresAt: number;
  desktop: boolean;
}

interface LoginAttempt {
  failures: number;
  resetAt: number;
}

interface RequestContext {
  clientAddress: string;
  host: string | undefined;
  protocol: 'http' | 'https';
  viaTrustedProxy: boolean;
}

export interface ServerRuntime {
  startedAt: string;
  sessions: Map<string, Session>;
  openTokens: Map<string, number>;
  loginAttempts: Map<string, LoginAttempt>;
  passwordOperations: { active: number; waiters: Array<() => void> };
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

export interface CreateServerOptions {
  config: NodeConfig;
  store: StateStore;
  syncthing: LocalSyncthing;
  openSecret: string;
  runtime?: ServerRuntime;
  directories?: DirectoryBrowser;
  files?: FolderFiles;
  passwordHasher?: PasswordHasher;
  onRebindRequested?: () => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createServerRuntime(): ServerRuntime {
  return {
    startedAt: new Date().toISOString(),
    sessions: new Map(),
    openTokens: new Map(),
    loginAttempts: new Map(),
    passwordOperations: { active: 0, waiters: [] },
  };
}

const bunPasswordHasher: PasswordHasher = {
  hash: (password) =>
    Bun.password.hash(password, {
      algorithm: 'argon2id',
      memoryCost: 65_536,
      timeCost: 3,
    }),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

function secretEqual(left: string, right: string) {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function canonicalIp(value: string | undefined) {
  const address = (value ?? '').toLowerCase().split('%')[0] ?? '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function isLoopbackAddress(value: string | undefined) {
  const address = canonicalIp(value);
  if (isIP(address) === 6) return address === '::1';
  if (isIP(address) !== 4) return false;
  return Number(address.split('.')[0]) === 127;
}

export function isLanAddress(value: string | undefined) {
  const address = canonicalIp(value);
  if (isLoopbackAddress(address)) return true;
  const version = isIP(address);
  if (version === 6) {
    return (
      address.startsWith('fc') ||
      address.startsWith('fd') ||
      address.startsWith('fe8') ||
      address.startsWith('fe9') ||
      address.startsWith('fea') ||
      address.startsWith('feb')
    );
  }
  if (version !== 4) return false;
  const parts = address.split('.').map(Number);
  const [first = -1, second = -1] = parts;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

export function hostName(value: string | undefined) {
  if (!value) return '';
  const authority = value.trim();
  if (!authority || /[\\/@?#\s]/.test(authority)) return '';
  const scopedIpv6 = /^\[([0-9a-f:.]+)(?:%(?:25)?[a-z0-9_.~-]+)?\](?::([0-9]{1,5}))?$/i.exec(
    authority,
  );
  if (scopedIpv6) {
    const address = scopedIpv6[1] ?? '';
    const port = scopedIpv6[2] === undefined ? undefined : Number(scopedIpv6[2]);
    return isIP(address) === 6 && (port === undefined || (port >= 1 && port <= 65_535))
      ? address.toLowerCase()
      : '';
  }
  try {
    return new URL(`http://${authority}`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.$/, '');
  } catch {
    return '';
  }
}

function localInterfaceAddresses() {
  return new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    '::',
    ...Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? []).map((entry) => canonicalIp(entry.address)),
    ),
  ]);
}

function hostAllowed(
  host: string | undefined,
  lan: boolean,
  protocol: 'http' | 'https',
  allowedOrigins: string[],
) {
  const name = hostName(host);
  if (!name) return false;
  if (name === 'localhost' || isLoopbackAddress(name)) return true;
  const systemName = hostname().toLocaleLowerCase('en-US').replace(/\.$/, '');
  const shortName = systemName.endsWith('.local')
    ? systemName.slice(0, -'.local'.length)
    : systemName;
  if (name === systemName || name === shortName || name === `${shortName}.local`) return true;
  const explicitOrigin = allowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return (
        parsed.protocol === `${protocol}:` && parsed.host.toLowerCase() === host?.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  if (explicitOrigin) return true;
  if (!lan) return false;
  if (localInterfaceAddresses().has(name) && isLanAddress(name)) return true;
  return false;
}

function trustedProxy(address: string, configured: string[]) {
  return (
    isLoopbackAddress(address) ||
    configured.some((entry) => {
      const candidate = entry.trim().toLowerCase();
      if (candidate === 'loopback') return isLoopbackAddress(address);
      const slash = candidate.lastIndexOf('/');
      if (slash === -1) return canonicalIp(candidate) === address;
      const network = canonicalIp(candidate.slice(0, slash));
      const prefix = Number(candidate.slice(slash + 1));
      const version = isIP(network);
      if (!version || !Number.isInteger(prefix)) return false;
      try {
        const block = new BlockList();
        block.addSubnet(network, prefix, version === 4 ? 'ipv4' : 'ipv6');
        return block.check(address, version === 4 ? 'ipv4' : 'ipv6');
      } catch {
        return false;
      }
    })
  );
}

function forwardedContext(request: FastifyRequest, settings: StoredNodeSettings): RequestContext {
  const direct = canonicalIp(request.socket.remoteAddress);
  let clientAddress = direct;
  let host = request.headers.host;
  let protocol: 'http' | 'https' = (request.socket as { encrypted?: boolean }).encrypted
    ? 'https'
    : 'http';
  const viaTrustedProxy = trustedProxy(direct, settings.trustedProxies);
  if (viaTrustedProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((value) => canonicalIp(value.trim()))
      .filter(Boolean);
    const chain = [...forwarded, direct];
    let index = chain.length - 1;
    while (index > 0 && trustedProxy(chain[index] ?? '', settings.trustedProxies)) index -= 1;
    clientAddress = chain[index] ?? direct;
    const forwardedHost = String(request.headers['x-forwarded-host'] ?? '')
      .split(',')[0]
      ?.trim();
    if (forwardedHost) host = forwardedHost;
    const forwardedProtocol = String(request.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim()
      .toLowerCase();
    if (forwardedProtocol === 'https' || forwardedProtocol === 'http') protocol = forwardedProtocol;
  }
  return { clientAddress, host, protocol, viaTrustedProxy };
}

function isDirectLoopbackRequest(request: FastifyRequest, context: RequestContext) {
  const forwarded =
    request.headers.forwarded !== undefined ||
    request.headers['x-forwarded-for'] !== undefined ||
    request.headers['x-forwarded-host'] !== undefined ||
    request.headers['x-forwarded-proto'] !== undefined;
  return (
    !forwarded &&
    isLoopbackAddress(request.socket.remoteAddress) &&
    isLoopbackAddress(context.clientAddress)
  );
}

function effectiveLanAccess(config: NodeConfig, settings: Pick<NodeSettings, 'lanAccessEnabled'>) {
  const host = config.hostOverride;
  if (host !== undefined) {
    return host.toLowerCase() !== 'localhost' && !isLoopbackAddress(host);
  }
  return settings.lanAccessEnabled;
}

function platform(): NodeInfo['platform'] {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function normalizeDate(value: string | undefined) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function optionalDate(value: string | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function normalizeDeviceId(value: string) {
  const id = value.trim().toUpperCase();
  if (!DEVICE_ID_PATTERN.test(id))
    throw new HttpError(400, 'invalid_device_id', '设备 ID 格式无效');
  return id;
}

function optionalDeviceId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    return normalizeDeviceId(value);
  } catch {
    return undefined;
  }
}

function validFolderId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    return false;
  }
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 31 && code !== 127;
  });
}

function boundedRemoteText(value: unknown, fallback: string, maximum: number) {
  if (typeof value !== 'string') return fallback.slice(0, maximum);
  const normalized = value.trim();
  return (normalized || fallback).slice(0, maximum);
}

function observedAddress(value: unknown) {
  return boundedRemoteText(value, 'dynamic', 512);
}

function discoveredAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) return false;
  if (value === 'dynamic') return true;
  try {
    normalizeAddresses([value]);
    return true;
  } catch {
    return false;
  }
}

function normalizeAddresses(addresses: string[] | undefined) {
  if (!addresses?.length) return ['dynamic'];
  return addresses.map((address) => {
    let value: URL;
    try {
      value = new URL(address);
    } catch {
      throw new HttpError(400, 'invalid_device_address', `设备地址无效：${address}`);
    }
    if (
      !['tcp:', 'quic:'].includes(value.protocol) ||
      value.username ||
      value.password ||
      !value.hostname ||
      !value.port ||
      (value.pathname !== '' && value.pathname !== '/') ||
      value.search ||
      value.hash
    ) {
      throw new HttpError(
        400,
        'invalid_device_address',
        `设备地址必须是 tcp://host:port 或 quic://host:port：${address}`,
      );
    }
    return address;
  });
}

function versioning(days: number) {
  return days > 0
    ? { type: 'staggered', params: { maxAge: String(days * 86_400) } }
    : { type: '', params: {} };
}

function versioningDays(folder: SyncthingFolderConfig) {
  if (folder.versioning?.type !== 'staggered') return 0;
  const seconds = Number(folder.versioning.params?.maxAge);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds / 86_400)) : 0;
}

function folderState(value: string | undefined, paused: boolean, failed = false): FolderState {
  if (paused) return 'paused';
  if (failed || value === 'error' || value === 'stopped') return 'error';
  if (value === 'idle') return 'idle';
  if (value?.includes('scan')) return 'scanning';
  if (value?.includes('sync')) return 'syncing';
  return 'idle';
}

function normalizeAllowedOrigins(values: string[]) {
  const result = values.map((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new HttpError(400, 'invalid_allowed_origin', `浏览器来源无效：${value}`);
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '')
    ) {
      throw new HttpError(
        400,
        'invalid_allowed_origin',
        `浏览器来源必须是纯 HTTPS origin：${value}`,
      );
    }
    return parsed.origin;
  });
  return [...new Set(result)];
}

function normalizeTrustedProxies(values: string[]) {
  const result = values.map((value) => {
    const candidate = value.trim().toLowerCase();
    if (candidate === 'loopback') return candidate;
    const [rawAddress = '', prefixValue] = candidate.split('/');
    const address = canonicalIp(rawAddress);
    const version = isIP(address);
    const prefix = prefixValue === undefined ? undefined : Number(prefixValue);
    const validPrefix =
      prefix === undefined ||
      (Number.isInteger(prefix) && prefix >= 0 && prefix <= (version === 4 ? 32 : 128));
    if (!version || !validPrefix || candidate.split('/').length > 2) {
      throw new HttpError(
        400,
        'invalid_trusted_proxy',
        `可信代理必须是 IP、CIDR 或 loopback：${value}`,
      );
    }
    return prefix === undefined ? address : `${address}/${prefix}`;
  });
  return [...new Set(result)];
}

function publicApi(path: string) {
  return new Set([
    '/api/v1/health',
    '/api/v1/auth/status',
    '/api/v1/auth/setup',
    '/api/v1/auth/login',
    '/api/v1/auth/open-token',
  ]).has(path);
}

function currentPreferences(config: NodeConfig, store: StateStore): StoredNodeSettings {
  const settings = store.snapshot().settings;
  return {
    ...settings,
    lanAccessEnabled: effectiveLanAccess(config, settings),
    ...(config.portOverride === undefined ? {} : { uiPort: config.portOverride }),
  };
}

async function currentSettings(
  config: NodeConfig,
  store: StateStore,
  syncthing: LocalSyncthing,
): Promise<NodeSettings> {
  const identity = await syncthing.identity();
  return { ...currentPreferences(config, store), nodeName: identity.nodeName };
}

export async function applyAdminPassword(
  config: NodeConfig,
  store: StateStore,
  passwordHasher: PasswordHasher = bunPasswordHasher,
) {
  if (!config.adminPasswordFile) return;
  const password = (await readFile(config.adminPasswordFile, 'utf8')).trimEnd();
  if (password.length < 12 || password.length > 256) {
    throw new Error('KITESYNC_ADMIN_PASSWORD_FILE 中的密码必须为 12 到 256 个字符');
  }
  const current = store.snapshot().passwordHash;
  if (current) return;
  const hash = await passwordHasher.hash(password);
  await store.update((draft) => {
    draft.passwordHash = hash;
  });
}

export function assertLanHasPassword(config: NodeConfig, store: StateStore) {
  const settings = currentPreferences(config, store);
  if (settings.lanAccessEnabled && !store.snapshot().passwordHash) {
    throw new Error('启用局域网界面前必须设置管理员密码；容器请配置 KITESYNC_ADMIN_PASSWORD_FILE');
  }
}

function sessionPayload(session: Session) {
  return {
    authenticated: true as const,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function contentType(path: string) {
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function parseRange(header: string | undefined, size: number) {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return null;
  const [, startValue = '', endValue = ''] = match;
  if (!startValue && !endValue) return null;
  let start: number;
  let end: number;
  if (!startValue) {
    const suffix = Number(endValue);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startValue);
    end = endValue ? Number(endValue) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

function requestRelativePath(value: string, allowRoot = true) {
  try {
    const path = safeRelativePath(value);
    if (!allowRoot && !path) throw new Error('请选择一个文件');
    return path;
  } catch (error) {
    throw new HttpError(
      400,
      'invalid_relative_path',
      error instanceof Error ? error.message : '文件路径无效',
    );
  }
}

async function webAsset(config: NodeConfig, requestPath: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  const normalized = posix.normalize(`/${decoded}`).replace(/^\/+/, '/');
  if (normalized.includes('/../')) return undefined;
  const candidates = normalized === '/' ? ['/index.html'] : [normalized];
  if (!extname(normalized)) candidates.push('/index.html');
  for (const candidate of candidates) {
    const embedded = embeddedWebAssets[candidate];
    if (embedded) {
      return { bytes: Buffer.from(embedded.base64, 'base64'), type: embedded.contentType };
    }
    try {
      const root = await realpath(config.webRoot);
      const path = await realpath(resolve(root, `.${candidate}`));
      if (!isWithinRoot(root, path) || !(await stat(path)).isFile()) continue;
      return { bytes: await readFile(path), type: contentType(path) };
    } catch {
      // Try the SPA fallback candidate.
    }
  }
  return undefined;
}

export async function createServer(options: CreateServerOptions) {
  const {
    config,
    store,
    syncthing,
    openSecret,
    onRebindRequested,
    passwordHasher = bunPasswordHasher,
    sleep = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  } = options;
  const runtime = options.runtime ?? createServerRuntime();
  const directories = options.directories ?? new DirectoryBrowser(config.directoryRoots);
  const files = options.files ?? new FolderFiles();
  const requestSessions = new WeakMap<FastifyRequest, Session>();
  const requestContexts = new WeakMap<FastifyRequest, RequestContext>();
  const app = Fastify({ logger: false, trustProxy: false });
  await app.register(cookie);

  async function acquirePasswordVerification() {
    if (runtime.passwordOperations.active < 2) {
      runtime.passwordOperations.active += 1;
    } else {
      if (runtime.passwordOperations.waiters.length >= 16) {
        throw new HttpError(429, 'login_capacity_limited', '登录验证繁忙，请稍后再试');
      }
      await new Promise<void>((resolvePromise) =>
        runtime.passwordOperations.waiters.push(resolvePromise),
      );
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = runtime.passwordOperations.waiters.shift();
      if (next) next();
      else runtime.passwordOperations.active -= 1;
    };
  }

  function authenticated(request: FastifyRequest) {
    const session = requestSessions.get(request);
    if (!session) throw new HttpError(401, 'authentication_required', '请先登录');
    return session;
  }

  function createSession(request: FastifyRequest, reply: FastifyReply, desktop: boolean) {
    while (runtime.sessions.size >= 256) {
      const oldest = runtime.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      runtime.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const session: Session = {
      csrfToken: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + SESSION_TTL_MS,
      desktop,
    };
    runtime.sessions.set(token, session);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1_000),
      secure: requestContexts.get(request)?.protocol === 'https',
    });
    return sessionPayload(session);
  }

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const settings = currentPreferences(config, store);
    const cleanupNow = Date.now();
    for (const [token, session] of runtime.sessions) {
      if (session.expiresAt <= cleanupNow) runtime.sessions.delete(token);
    }
    for (const [token, expiresAt] of runtime.openTokens) {
      if (expiresAt <= cleanupNow) runtime.openTokens.delete(token);
    }
    for (const [address, attempt] of runtime.loginAttempts) {
      if (attempt.resetAt <= cleanupNow) runtime.loginAttempts.delete(address);
    }
    const lan = settings.lanAccessEnabled;
    const directPeer = request.socket.remoteAddress;
    const context = forwardedContext(request, settings);
    requestContexts.set(request, context);
    if (path.startsWith('/internal/') && !isDirectLoopbackRequest(request, context)) {
      throw new HttpError(403, 'loopback_required', '此接口只允许本机直接访问');
    }
    const directAllowed = lan ? isLanAddress(directPeer) : isLoopbackAddress(directPeer);
    const clientAllowed = lan
      ? isLanAddress(context.clientAddress)
      : isLoopbackAddress(context.clientAddress);
    const proxyOriginAllowed =
      context.viaTrustedProxy &&
      context.protocol === 'https' &&
      settings.allowedOrigins.some((origin) => {
        try {
          return new URL(origin).host.toLowerCase() === context.host?.toLowerCase();
        } catch {
          return false;
        }
      });
    if ((!directAllowed && !proxyOriginAllowed) || (!clientAllowed && !proxyOriginAllowed)) {
      throw new HttpError(403, 'network_access_denied', '当前网络地址无权访问此节点');
    }
    if (!hostAllowed(context.host, lan, context.protocol, settings.allowedOrigins)) {
      throw new HttpError(403, 'host_not_allowed', 'Host 请求头不在允许范围内');
    }

    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (origin) {
      let sameOrigin = false;
      try {
        const parsed = new URL(origin);
        sameOrigin =
          parsed.origin === origin &&
          parsed.protocol === `${context.protocol}:` &&
          parsed.host.toLowerCase() === context.host?.toLowerCase();
      } catch {
        // Invalid browser origins are denied below.
      }
      if (!sameOrigin && !settings.allowedOrigins.includes(origin)) {
        throw new HttpError(403, 'origin_not_allowed', '浏览器来源不在允许范围内');
      }
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      reply.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
      return reply.status(204).send();
    }

    const now = Date.now();
    const sessionToken = request.cookies[SESSION_COOKIE];
    const session = sessionToken ? runtime.sessions.get(sessionToken) : undefined;
    if (session && session.expiresAt > now) requestSessions.set(request, session);
    else if (sessionToken) runtime.sessions.delete(sessionToken);

    if (path.startsWith('/api/') && !publicApi(path)) {
      const active = authenticated(request);
      if (!['GET', 'HEAD'].includes(request.method)) {
        const csrf = request.headers['x-csrf-token'];
        const value = Array.isArray(csrf) ? csrf[0] : csrf;
        if (!value || !secretEqual(value, active.csrfToken)) {
          throw new HttpError(403, 'csrf_failed', 'CSRF 校验失败');
        }
      }
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    const path = request.url.split('?')[0] ?? request.url;
    if (path === '/health' || path.startsWith('/api/') || path.startsWith('/internal/')) {
      reply.header('Cache-Control', 'private, no-store');
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as {
      statusCode?: number;
      message?: string;
      validation?: Array<{ instancePath?: string; message?: string }>;
    };
    const status =
      error instanceof HttpError
        ? error.statusCode
        : typeof fastifyError.statusCode === 'number' && fastifyError.statusCode >= 400
          ? fastifyError.statusCode
          : 500;
    const validation = Array.isArray(fastifyError.validation) ? fastifyError.validation : undefined;
    const code =
      error instanceof HttpError
        ? error.code
        : validation
          ? 'validation_error'
          : status === 404
            ? 'not_found'
            : 'internal_error';
    const detail =
      status >= 500 ? '节点服务处理请求时发生错误' : (fastifyError.message ?? '请求无效');
    void reply.status(status).send({
      type: 'about:blank',
      title: status >= 500 ? '节点服务错误' : '请求失败',
      status,
      detail,
      instance: request.url,
      traceId: request.id,
      code,
      ...(validation
        ? {
            errors: validation.map((item) => ({
              path: item.instancePath || '/',
              message: item.message ?? '输入无效',
            })),
          }
        : {}),
    });
  });

  app.get('/health', async (request, reply) => {
    reply.header('X-KiteSync-Service', 'node');
    const supplied = request.headers['x-kitesync-health-challenge'];
    const challenge = Array.isArray(supplied) ? supplied[0] : supplied;
    if (challenge && /^[A-Za-z0-9_-]{16,256}$/.test(challenge)) {
      reply.header(
        'X-KiteSync-Health-Proof',
        createHmac('sha256', openSecret).update(challenge).digest('base64url'),
      );
    }
    return { status: 'ok' as const };
  });
  app.get('/api/v1/health', async () => {
    try {
      await syncthing.status();
      return { status: 'ok' as const };
    } catch {
      return { status: 'degraded' as const };
    }
  });

  app.get('/api/v1/auth/status', { schema: { response: { 200: AuthStatusSchema } } }, async () => ({
    setupRequired: !store.snapshot().passwordHash,
  }));

  app.post<{ Body: SetupRequest }>(
    '/api/v1/auth/setup',
    { schema: { body: SetupRequestSchema } },
    async (request, reply) => {
      if (store.snapshot().passwordHash) {
        throw new HttpError(409, 'already_configured', '管理员密码已经设置');
      }
      const releasePasswordOperation = await acquirePasswordVerification();
      let hash: string;
      try {
        if (store.snapshot().passwordHash) {
          throw new HttpError(409, 'already_configured', '管理员密码已经设置');
        }
        hash = await passwordHasher.hash(request.body.password);
      } finally {
        releasePasswordOperation();
      }
      await store.update((draft) => {
        if (draft.passwordHash)
          throw new HttpError(409, 'already_configured', '管理员密码已经设置');
        draft.passwordHash = hash;
      });
      return createSession(
        request,
        reply,
        !config.headless && isLoopbackAddress(requestContexts.get(request)?.clientAddress),
      );
    },
  );

  app.post<{ Body: LoginRequest }>(
    '/api/v1/auth/login',
    { schema: { body: LoginRequestSchema } },
    async (request, reply) => {
      const key =
        requestContexts.get(request)?.clientAddress ?? canonicalIp(request.socket.remoteAddress);
      const now = Date.now();
      const previous = runtime.loginAttempts.get(key);
      const attempt =
        !previous || previous.resetAt <= now
          ? { failures: 0, resetAt: now + 15 * 60_000 }
          : previous;
      if (attempt.failures >= 5)
        throw new HttpError(429, 'login_rate_limited', '登录尝试过多，请稍后再试');
      const hash = store.snapshot().passwordHash;
      if (!hash) throw new HttpError(409, 'setup_required', '请先设置管理员密码');
      // Reserve the failure budget before the expensive Argon2 operation. JavaScript runs this
      // section synchronously, so parallel requests from one client cannot all observe zero.
      attempt.failures += 1;
      const failureNumber = attempt.failures;
      runtime.loginAttempts.set(key, attempt);
      while (runtime.loginAttempts.size > 1_024) {
        const oldest = runtime.loginAttempts.keys().next().value as string | undefined;
        if (!oldest) break;
        runtime.loginAttempts.delete(oldest);
      }
      const releaseVerification = await acquirePasswordVerification();
      let verified = false;
      try {
        verified = await passwordHasher.verify(request.body.password, hash);
      } finally {
        releaseVerification();
      }
      if (!verified) {
        await sleep(Math.min(250 * 2 ** (failureNumber - 1), 4_000));
        throw new HttpError(401, 'invalid_credentials', '密码不正确');
      }
      runtime.loginAttempts.delete(key);
      return createSession(
        request,
        reply,
        !config.headless && isLoopbackAddress(requestContexts.get(request)?.clientAddress),
      );
    },
  );

  app.post<{ Body: OpenTokenLoginRequest }>(
    '/api/v1/auth/open-token',
    { schema: { body: OpenTokenLoginRequestSchema } },
    async (request, reply) => {
      const context = requestContexts.get(request);
      if (!context || !isDirectLoopbackRequest(request, context)) {
        throw new HttpError(403, 'loopback_required', '桌面打开令牌只能在本机兑换');
      }
      if (!store.snapshot().passwordHash)
        throw new HttpError(409, 'setup_required', '请先设置管理员密码');
      let matched: string | undefined;
      const now = Date.now();
      for (const [token, expiresAt] of runtime.openTokens) {
        if (expiresAt <= now) {
          runtime.openTokens.delete(token);
          continue;
        }
        if (secretEqual(token, request.body.token)) matched = token;
      }
      if (!matched) throw new HttpError(401, 'invalid_open_token', '打开令牌无效或已过期');
      runtime.openTokens.delete(matched);
      const existing = requestSessions.get(request);
      if (existing) {
        existing.desktop = true;
        return sessionPayload(existing);
      }
      return createSession(request, reply, true);
    },
  );

  app.post('/internal/open-token', async (request) => {
    const header = request.headers['x-kitesync-open-secret'];
    const supplied = Array.isArray(header) ? header[0] : header;
    if (!supplied || !secretEqual(supplied, openSecret)) {
      throw new HttpError(401, 'invalid_open_secret', '本机打开凭据无效');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + OPEN_TOKEN_TTL_MS;
    while (runtime.openTokens.size >= 64) {
      const oldest = runtime.openTokens.keys().next().value as string | undefined;
      if (!oldest) break;
      runtime.openTokens.delete(oldest);
    }
    runtime.openTokens.set(token, expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.get('/api/v1/auth/session', async (request) => sessionPayload(authenticated(request)));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) runtime.sessions.delete(token);
    reply.clearCookie(SESSION_COOKIE, {
      path: '/',
      secure: requestContexts.get(request)?.protocol === 'https',
    });
    return { message: '已退出登录' };
  });

  app.get('/api/v1/node', async (request): Promise<NodeInfo> => {
    const session = authenticated(request);
    const [identity, connections] = await Promise.all([
      syncthing.identity(),
      syncthing.connections(),
    ]);
    return {
      deviceId: identity.deviceId,
      fingerprint: identity.deviceId.replaceAll('-', '').slice(0, 12),
      name: identity.nodeName,
      platform: platform(),
      version: config.version,
      syncthingVersion: identity.syncthingVersion,
      startedAt: runtime.startedAt,
      setupRequired: !store.snapshot().passwordHash,
      listenAddresses: identity.listenAddresses,
      localDiscoveryEnabled: identity.localDiscoveryEnabled,
      connectedPeers: Object.values(connections.connections).filter((item) => item.connected)
        .length,
      canRevealFiles: session.desktop && !config.headless,
    };
  });

  app.get('/api/v1/settings', async () => currentSettings(config, store, syncthing));
  app.patch<{ Body: UpdateNodeSettings }>(
    '/api/v1/settings',
    { schema: { body: UpdateNodeSettingsSchema } },
    async (request, reply) => {
      const before = currentPreferences(config, store).lanAccessEnabled;
      const { nodeName, lanAccessEnabled, ...otherPreferences } = request.body;
      if (
        config.hostOverride !== undefined &&
        lanAccessEnabled !== undefined &&
        lanAccessEnabled !== effectiveLanAccess(config, { lanAccessEnabled: false })
      ) {
        throw new HttpError(
          409,
          'listen_override_active',
          'KITESYNC_UI_HOST 已固定管理界面监听范围，不能从界面修改',
        );
      }
      // The settings form posts its complete current value. When an environment override is
      // active, accept the matching effective value but do not persist it as misleading state.
      const preferences = {
        ...otherPreferences,
        ...(config.hostOverride === undefined && lanAccessEnabled !== undefined
          ? { lanAccessEnabled }
          : {}),
      };
      if (preferences.allowedOrigins) {
        preferences.allowedOrigins = normalizeAllowedOrigins(preferences.allowedOrigins);
      }
      if (preferences.trustedProxies) {
        preferences.trustedProxies = normalizeTrustedProxies(preferences.trustedProxies);
      }
      if (Object.keys(preferences).length) {
        await store.update((draft) => {
          draft.settings = { ...draft.settings, ...preferences };
        });
      }
      if (nodeName) await syncthing.setNodeName(nodeName);
      const after = await currentSettings(config, store, syncthing);
      if (before !== after.lanAccessEnabled && !config.hostOverride && onRebindRequested) {
        reply.raw.once('finish', onRebindRequested);
      }
      return after;
    },
  );

  async function deviceView(
    value: SyncthingDeviceConfig,
    snapshots?: {
      connections: Awaited<ReturnType<LocalSyncthing['connections']>>;
      stats: Awaited<ReturnType<LocalSyncthing['deviceStats']>>;
    },
  ): Promise<Device> {
    let current = snapshots;
    if (!current) {
      const [connections, stats] = await Promise.all([
        syncthing.connections(),
        syncthing.deviceStats(),
      ]);
      current = { connections, stats };
    }
    const connection = current.connections.connections[value.deviceID];
    return {
      id: value.deviceID,
      name: (value.name || value.deviceID.slice(0, 7)).slice(0, 64),
      addresses: value.addresses?.length ? value.addresses.slice(0, 32) : ['dynamic'],
      connected: connection?.connected === true,
      paused: value.paused === true,
      lastSeenAt: optionalDate(current.stats[value.deviceID]?.lastSeen),
    };
  }

  async function folderView(value: SyncthingFolderConfig): Promise<Folder> {
    const [status, identity] = await Promise.all([
      syncthing.folderStatus(value.id).catch(
        (): {
          state?: string;
          localBytes?: number;
          globalBytes?: number;
          needBytes?: number;
          error?: string;
          watchError?: string;
          errors?: number;
        } => ({ state: 'error', error: '无法读取同步状态' }),
      ),
      syncthing.status(),
    ]);
    const pathLabel = (basename(value.path) || value.label || '同步目录').slice(0, 255);
    const failed = Boolean(status.error || status.watchError || (status.errors ?? 0) > 0);
    const safeError = failed ? 'Syncthing 报告扫描、监视或同步错误' : null;
    return {
      id: value.id,
      label: (value.label || value.id).slice(0, 128),
      pathLabel,
      type: value.type ?? 'sendreceive',
      paused: value.paused === true,
      deviceIds: (value.devices ?? [])
        .map((device) => device.deviceID)
        .filter((id) => id !== identity.myID),
      state: folderState(status.state, value.paused === true, failed),
      localBytes: Math.max(0, Math.floor(status.localBytes ?? 0)),
      globalBytes: Math.max(0, Math.floor(status.globalBytes ?? 0)),
      needBytes: Math.max(0, Math.floor(status.needBytes ?? 0)),
      error: safeError,
      versioningDays: versioningDays(value),
    };
  }

  const DeviceParamsSchema = Type.Object({ id: Type.String({ minLength: 32, maxLength: 80 }) });
  const FolderParamsSchema = Type.Object({ id: FolderIdSchema });
  const PendingFolderParamsSchema = Type.Object({
    deviceId: Type.String({ minLength: 32, maxLength: 80 }),
    folderId: FolderIdSchema,
  });

  async function folderDevices(
    deviceIds: string[],
    existing: Array<{ deviceID: string; [key: string]: unknown }> = [],
  ) {
    const self = (await syncthing.status()).myID;
    const configured = new Set(
      (await syncthing.devices())
        .map((device) => device.deviceID)
        .filter((deviceId) => deviceId !== self),
    );
    const peers = [...new Set(deviceIds.map(normalizeDeviceId))];
    if (peers.some((deviceId) => deviceId === self || !configured.has(deviceId))) {
      throw new HttpError(400, 'unknown_folder_device', '文件夹成员必须是已配对的远端设备');
    }
    const configuredValues = new Map(existing.map((device) => [device.deviceID, device]));
    return [self, ...peers].map((deviceID) => configuredValues.get(deviceID) ?? { deviceID });
  }

  app.get('/api/v1/devices', async () => ({
    items: await (async () => {
      const [status, devices, connections, stats] = await Promise.all([
        syncthing.status(),
        syncthing.devices(),
        syncthing.connections(),
        syncthing.deviceStats(),
      ]);
      return Promise.all(
        devices
          .filter((item) => item.deviceID !== status.myID)
          .map((device) => deviceView(device, { connections, stats })),
      );
    })(),
  }));

  app.post<{ Body: CreateDeviceRequest }>(
    '/api/v1/devices',
    { schema: { body: CreateDeviceRequestSchema } },
    async (request) => {
      const deviceID = normalizeDeviceId(request.body.deviceId);
      const [status, configured, ignored] = await Promise.all([
        syncthing.status(),
        syncthing.devices(),
        syncthing.ignoredDevices(),
      ]);
      if (deviceID === status.myID) {
        throw new HttpError(400, 'self_device_forbidden', '不能把本机添加为远端设备');
      }
      if (configured.some((device) => device.deviceID === deviceID)) {
        throw new HttpError(409, 'device_already_configured', '该设备已经配对');
      }
      if (ignored.some((device) => device.deviceID === deviceID)) {
        throw new HttpError(409, 'device_ignored', '请先在已忽略设备中允许重新配对');
      }
      await syncthing.putDevice({
        deviceID,
        name: request.body.name,
        addresses: normalizeAddresses(request.body.addresses),
        paused: false,
        autoAcceptFolders: false,
        introducer: false,
      });
      return deviceView(await syncthing.device(deviceID));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateDeviceRequest }>(
    '/api/v1/devices/:id',
    { schema: { params: DeviceParamsSchema, body: UpdateDeviceRequestSchema } },
    async (request) => {
      const id = normalizeDeviceId(request.params.id);
      if (id === (await syncthing.status()).myID) {
        throw new HttpError(400, 'self_device_forbidden', '不能通过远端设备接口修改本机');
      }
      await syncthing.patchDevice(id, {
        ...(request.body.name === undefined ? {} : { name: request.body.name }),
        ...(request.body.addresses === undefined
          ? {}
          : { addresses: normalizeAddresses(request.body.addresses) }),
        ...(request.body.paused === undefined ? {} : { paused: request.body.paused }),
        introducer: false,
        autoAcceptFolders: false,
      });
      return deviceView(await syncthing.device(id));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/devices/:id',
    { schema: { params: DeviceParamsSchema } },
    async (request) => {
      const id = normalizeDeviceId(request.params.id);
      if (id === (await syncthing.status()).myID) {
        throw new HttpError(400, 'self_device_forbidden', '不能删除本机设备');
      }
      await syncthing.removeAndIgnoreDevice(id);
      return { message: '设备已删除' };
    },
  );

  app.get('/api/v1/devices/discovered', async () => {
    const [status, configured, ignored, discovered] = await Promise.all([
      syncthing.status(),
      syncthing.devices(),
      syncthing.ignoredDevices(),
      syncthing.discovery(),
    ]);
    const hidden = new Set(
      [
        optionalDeviceId(status.myID),
        ...configured.map((device) => optionalDeviceId(device.deviceID)),
        ...ignored.map((device) => optionalDeviceId(device.deviceID)),
      ].filter((id): id is string => Boolean(id)),
    );
    return {
      items: Object.entries(discovered).flatMap(([rawId, rawValue]) => {
        const id = optionalDeviceId(rawId);
        if (!id || hidden.has(id) || !rawValue || typeof rawValue !== 'object') return [];
        const addresses = Array.isArray(rawValue.addresses)
          ? rawValue.addresses.filter(discoveredAddress).slice(0, 32)
          : [];
        return [{ id, addresses }];
      }),
    };
  });

  app.get('/api/v1/devices/pending', async () => {
    const [pending, ignored] = await Promise.all([
      syncthing.pendingDevices(),
      syncthing.ignoredDevices(),
    ]);
    const safeIgnored = ignored.flatMap((value) => {
      const id = optionalDeviceId(value?.deviceID);
      if (!id) return [];
      return [
        {
          id,
          name: boundedRemoteText(value.name, id.slice(0, 7), 64),
          address: observedAddress(value.address),
          ignoredAt: normalizeDate(value.time),
        },
      ];
    });
    const ignoredIds = new Set(safeIgnored.map((value) => value.id));
    return {
      items: Object.entries(pending).flatMap(([rawId, rawValue]) => {
        const id = optionalDeviceId(rawId);
        if (!id || ignoredIds.has(id) || !rawValue || typeof rawValue !== 'object') return [];
        return [
          {
            id,
            name: boundedRemoteText(rawValue.name, id.slice(0, 7), 64),
            address: observedAddress(rawValue.address),
            seenAt: normalizeDate(rawValue.time),
          },
        ];
      }),
      ignored: safeIgnored,
    };
  });

  app.post<{ Params: { id: string }; Body: AcceptPendingDeviceRequest }>(
    '/api/v1/devices/pending/:id/accept',
    { schema: { params: DeviceParamsSchema, body: AcceptPendingDeviceRequestSchema } },
    async (request) => {
      const id = normalizeDeviceId(request.params.id);
      const [status, ignored] = await Promise.all([syncthing.status(), syncthing.ignoredDevices()]);
      if (id === status.myID) {
        throw new HttpError(400, 'self_device_forbidden', '不能接受本机为远端设备');
      }
      if (ignored.some((device) => optionalDeviceId(device.deviceID) === id)) {
        throw new HttpError(409, 'device_ignored', '请先在已忽略设备中允许重新配对');
      }
      const pending = (await syncthing.pendingDevices())[id];
      if (!pending || typeof pending !== 'object') {
        throw new HttpError(404, 'pending_device_not_found', '待处理设备不存在');
      }
      await syncthing.putDevice({
        deviceID: id,
        name: boundedRemoteText(request.body.name ?? pending.name, id.slice(0, 7), 64),
        addresses: ['dynamic'],
        paused: false,
        autoAcceptFolders: false,
        introducer: false,
      });
      await syncthing.dismissPendingDevice(id).catch(() => undefined);
      return deviceView(await syncthing.device(id));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/devices/pending/:id/reject',
    { schema: { params: DeviceParamsSchema } },
    async (request) => {
      await syncthing.ignorePendingDevice(normalizeDeviceId(request.params.id));
      return { message: '已忽略该设备' };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/devices/ignored/:id',
    { schema: { params: DeviceParamsSchema } },
    async (request) => {
      await syncthing.unignoreDevice(normalizeDeviceId(request.params.id));
      return { message: '已取消忽略该设备' };
    },
  );

  app.get('/api/v1/folders', async () => ({
    items: await Promise.all((await syncthing.folders()).map(folderView)),
  }));

  app.post<{ Body: CreateFolderRequest }>(
    '/api/v1/folders',
    { schema: { body: CreateFolderRequestSchema } },
    async (request) => {
      const selection = await directories.resolveSelection(request.body.directoryId);
      const id = `folder-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const days = currentPreferences(config, store).versioningDays;
      const devices = await folderDevices(request.body.deviceIds ?? []);
      await syncthing.putFolder({
        id,
        label: request.body.label,
        path: selection.path,
        type: request.body.type ?? 'sendreceive',
        paused: false,
        devices,
        versioning: versioning(days),
      });
      return folderView(await syncthing.folder(id));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateFolderRequest }>(
    '/api/v1/folders/:id',
    { schema: { params: FolderParamsSchema, body: UpdateFolderRequestSchema } },
    async (request) => {
      const current = await syncthing.folder(request.params.id);
      const devices =
        request.body.deviceIds === undefined
          ? undefined
          : await folderDevices(request.body.deviceIds, current.devices);
      await syncthing.patchFolder(request.params.id, {
        ...(request.body.label === undefined ? {} : { label: request.body.label }),
        ...(request.body.type === undefined ? {} : { type: request.body.type }),
        ...(devices === undefined ? {} : { devices }),
        ...(request.body.versioningDays === undefined
          ? {}
          : { versioning: versioning(request.body.versioningDays) }),
      });
      return folderView({ ...current, ...(await syncthing.folder(request.params.id)) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/folders/:id',
    { schema: { params: FolderParamsSchema } },
    async (request) => {
      await syncthing.removeFolder(request.params.id);
      return { message: '文件夹已删除，本地文件未被删除' };
    },
  );

  for (const [action, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/folders/:id/${action}`,
      { schema: { params: FolderParamsSchema } },
      async (request) => {
        await syncthing.patchFolder(request.params.id, { paused });
        return folderView(await syncthing.folder(request.params.id));
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    '/api/v1/folders/:id/scan',
    { schema: { params: FolderParamsSchema } },
    async (request) => {
      await syncthing.scanFolder(request.params.id);
      return { message: '已开始扫描文件夹' };
    },
  );

  app.get('/api/v1/folders/pending', async () => {
    const [pending, ignored, devices] = await Promise.all([
      syncthing.pendingFolders(),
      syncthing.ignoredFolders(),
      syncthing.devices(),
    ]);
    const names = new Map(
      devices.flatMap((device) => {
        const id = optionalDeviceId(device.deviceID);
        return id ? [[id, boundedRemoteText(device.name, id.slice(0, 7), 64)] as const] : [];
      }),
    );
    const safeIgnored = ignored.flatMap((folder) => {
      const deviceId = optionalDeviceId(folder?.deviceId);
      if (!deviceId || !validFolderId(folder?.folderId)) return [];
      return [
        {
          folderId: folder.folderId,
          label: boundedRemoteText(folder.label, folder.folderId, 128),
          deviceId,
          deviceName: boundedRemoteText(folder.deviceName, deviceId.slice(0, 7), 64),
          ignoredAt: normalizeDate(folder.ignoredAt),
        },
      ];
    });
    const ignoredKeys = new Set(
      safeIgnored.map((folder) => `${folder.deviceId}\0${folder.folderId}`),
    );
    return {
      items: pending
        .flatMap((folder) => {
          const deviceId = optionalDeviceId(folder?.deviceId);
          if (!deviceId || !validFolderId(folder?.folderId)) return [];
          return [
            {
              folderId: folder.folderId,
              label: boundedRemoteText(folder.label, folder.folderId, 128),
              deviceId,
              deviceName: boundedRemoteText(names.get(deviceId), deviceId.slice(0, 7), 64),
              offeredAt: normalizeDate(folder.offeredAt),
            },
          ];
        })
        .filter((folder) => !ignoredKeys.has(`${folder.deviceId}\0${folder.folderId}`)),
      ignored: safeIgnored,
    };
  });

  app.post<{
    Params: { deviceId: string; folderId: string };
    Body: AcceptPendingFolderRequest;
  }>(
    '/api/v1/folders/pending/:deviceId/:folderId/accept',
    { schema: { params: PendingFolderParamsSchema, body: AcceptPendingFolderRequestSchema } },
    async (request) => {
      const deviceId = normalizeDeviceId(request.params.deviceId);
      const [pendingFolders, configuredFolders] = await Promise.all([
        syncthing.pendingFolders(),
        syncthing.folders(),
      ]);
      const pending = pendingFolders.find(
        (folder) =>
          optionalDeviceId(folder?.deviceId) === deviceId &&
          validFolderId(folder?.folderId) &&
          folder.folderId === request.params.folderId,
      );
      if (!pending) throw new HttpError(404, 'pending_folder_not_found', '待处理文件夹不存在');
      if (configuredFolders.some((folder) => folder.id === pending.folderId)) {
        throw new HttpError(
          409,
          'folder_already_configured',
          '同 ID 文件夹已存在，不能用远端邀请覆盖本机配置',
        );
      }
      if (
        (await syncthing.ignoredFolders()).some(
          (folder) =>
            optionalDeviceId(folder.deviceId) === deviceId && folder.folderId === pending.folderId,
        )
      ) {
        throw new HttpError(409, 'folder_ignored', '请先在设置中取消忽略该文件夹');
      }
      const selection = await directories.resolveSelection(request.body.directoryId);
      const days = currentPreferences(config, store).versioningDays;
      const devices = await folderDevices([deviceId]);
      await syncthing.putFolder({
        id: pending.folderId,
        label: boundedRemoteText(pending.label, pending.folderId, 128),
        path: selection.path,
        type: request.body.type ?? 'sendreceive',
        paused: false,
        devices,
        versioning: versioning(days),
      });
      await syncthing.dismissPendingFolder(deviceId, pending.folderId).catch(() => undefined);
      return folderView(await syncthing.folder(pending.folderId));
    },
  );

  app.post<{ Params: { deviceId: string; folderId: string } }>(
    '/api/v1/folders/pending/:deviceId/:folderId/reject',
    { schema: { params: PendingFolderParamsSchema } },
    async (request) => {
      await syncthing.ignorePendingFolder(
        normalizeDeviceId(request.params.deviceId),
        request.params.folderId,
      );
      return { message: '已忽略该文件夹邀请' };
    },
  );

  app.delete<{ Params: { deviceId: string; folderId: string } }>(
    '/api/v1/folders/ignored/:deviceId/:folderId',
    { schema: { params: PendingFolderParamsSchema } },
    async (request) => {
      await syncthing.unignoreFolder(
        normalizeDeviceId(request.params.deviceId),
        request.params.folderId,
      );
      return { message: '已取消忽略该文件夹' };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/folders/:id/versions',
    { schema: { params: FolderParamsSchema } },
    async (request) => {
      const versions = await syncthing.folderVersions(request.params.id);
      return {
        items: Object.entries(versions)
          .flatMap(([path, entries]) => {
            try {
              const safePath = safeRelativePath(path);
              if (!safePath) return [];
              const apiPath = safePath.split(sep).join('/');
              return entries.map((entry) => ({
                path: apiPath,
                versionTime: normalizeDate(entry.versionTime),
                size: Math.max(0, Math.floor(entry.size)),
              }));
            } catch {
              return [];
            }
          })
          .sort((left, right) => right.versionTime.localeCompare(left.versionTime)),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: RestoreVersionsRequest }>(
    '/api/v1/folders/:id/restore',
    { schema: { params: FolderParamsSchema, body: RestoreVersionsRequestSchema } },
    async (request) => {
      const path = requestRelativePath(request.body.path, false).split(sep).join('/');
      const result = await syncthing.restoreVersion(
        request.params.id,
        path,
        request.body.versionTime,
      );
      const failures = Object.values(result ?? {}).filter(Boolean);
      if (failures.length) throw new HttpError(409, 'restore_failed', 'Syncthing 无法恢复该版本');
      return { message: '文件版本已恢复' };
    },
  );

  app.get<{ Params: { id: string }; Querystring: FolderFilesQuery }>(
    '/api/v1/folders/:id/files',
    { schema: { params: FolderParamsSchema, querystring: FolderFilesQuerySchema } },
    async (request) => {
      const folder = await syncthing.folder(request.params.id);
      const path = requestRelativePath(request.query.path ?? '');
      return files.list(
        folder.id,
        folder.path,
        path,
        request.query.limit ?? 100,
        request.query.cursor,
      );
    },
  );

  app.route<{
    Params: { id: string };
    Querystring: RevealFileRequest;
  }>({
    method: ['GET', 'HEAD'],
    url: '/api/v1/folders/:id/download',
    schema: { params: FolderParamsSchema, querystring: RevealFileRequestSchema },
    handler: async (request, reply) => {
      const folder = await syncthing.folder(request.params.id);
      const file = await files.file(folder.path, requestRelativePath(request.query.path, false));
      let streaming = false;
      try {
        const name = basename(file.path);
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        const rangeHeader = Array.isArray(request.headers.range)
          ? request.headers.range[0]
          : request.headers.range;
        const range = parseRange(rangeHeader, file.info.size);
        if (range === null) {
          reply.header('Content-Range', `bytes */${file.info.size}`);
          throw new HttpError(416, 'range_not_satisfiable', '请求的文件范围无效');
        }
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Length', range ? range.end - range.start + 1 : file.info.size);
        reply.header('Last-Modified', file.info.mtime.toUTCString());
        reply.header(
          'Content-Disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        if (range) {
          reply.status(206);
          reply.header('Content-Range', `bytes ${range.start}-${range.end}/${file.info.size}`);
        }
        if (request.method === 'HEAD') return reply.send();
        const stream = file.stream(range ?? undefined);
        streaming = true;
        return reply.send(stream);
      } finally {
        if (!streaming) await file.close().catch(() => undefined);
      }
    },
  });

  app.post<{ Params: { id: string }; Body: RevealFileRequest }>(
    '/api/v1/folders/:id/reveal',
    { schema: { params: FolderParamsSchema, body: RevealFileRequestSchema } },
    async (request) => {
      const session = authenticated(request);
      if (config.headless || !session.desktop) {
        throw new HttpError(
          403,
          'desktop_session_required',
          '仅桌面打开的会话可以在文件管理器中显示文件',
        );
      }
      const folder = await syncthing.folder(request.params.id);
      await files.reveal(folder.path, requestRelativePath(request.body.path));
      return { message: '已在文件管理器中显示' };
    },
  );

  app.get('/api/v1/directory-roots', async () => directories.roots());
  app.get<{ Querystring: DirectoryQuery }>(
    '/api/v1/directories',
    { schema: { querystring: DirectoryQuerySchema } },
    async (request) =>
      directories.list(request.query.parentId, request.query.limit ?? 100, request.query.cursor),
  );

  app.setNotFoundHandler(async (request, reply) => {
    const requestPath = request.url.split('?')[0] ?? request.url;
    if (requestPath.startsWith('/api/') || requestPath.startsWith('/internal/')) {
      throw new HttpError(404, 'not_found', '接口不存在');
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      throw new HttpError(404, 'not_found', '页面不存在');
    }
    const asset = await webAsset(config, requestPath);
    if (!asset) throw new HttpError(404, 'not_found', '页面资源不存在，请先构建 Web 应用');
    reply.header('Content-Type', asset.type);
    reply.header('Content-Length', asset.bytes.byteLength);
    if (requestPath.startsWith('/assets/'))
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    else reply.header('Cache-Control', 'no-store');
    return reply.send(request.method === 'HEAD' ? undefined : asset.bytes);
  });

  return app;
}
