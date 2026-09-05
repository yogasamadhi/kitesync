import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertSyncthingSource,
  repositoryRoot,
  syncthingMetadata,
  syncthingSource,
} from './syncthing-source.mjs';

export const goModuleInventoryPath = resolve(repositoryRoot, 'vendor/syncthing/GO_MODULES.json');
export const goModuleNoticesPath = resolve(
  repositoryRoot,
  'vendor/syncthing/SYNCTHING_THIRD_PARTY_LICENSES.txt',
);

export const goModuleTargets = [
  { id: 'darwin-amd64', markerId: 'darwin-x64', goos: 'darwin', goarch: 'amd64' },
  { id: 'darwin-arm64', markerId: 'darwin-arm64', goos: 'darwin', goarch: 'arm64' },
  { id: 'linux-amd64', markerId: 'linux-x64', goos: 'linux', goarch: 'amd64' },
  { id: 'linux-arm64', markerId: 'linux-arm64', goos: 'linux', goarch: 'arm64' },
  { id: 'windows-amd64', markerId: 'win32-x64', goos: 'windows', goarch: 'amd64' },
];

// Each entry is an explicit legal review decision. A dependency update or a new
// target must add a reviewed SPDX expression here before the repository passes
// its license gate. License text hashes are independently derived below.
const reviewedLicenses = {
  'github.com/AudriusButkevicius/recli': 'MPL-2.0',
  'github.com/Azure/go-ntlmssp': 'MIT',
  'github.com/alecthomas/kong': 'MIT',
  'github.com/beorn7/perks': 'MIT',
  'github.com/calmh/incontainer': 'MIT',
  'github.com/calmh/xdr': 'MIT',
  'github.com/ccding/go-stun': 'Apache-2.0',
  'github.com/cespare/xxhash/v2': 'MIT',
  'github.com/cpuguy83/go-md2man/v2': 'MIT',
  'github.com/davecgh/go-spew': 'ISC',
  'github.com/dustin/go-humanize': 'MIT',
  'github.com/ebitengine/purego': 'Apache-2.0',
  'github.com/go-asn1-ber/asn1-ber': 'MIT',
  'github.com/go-ldap/ldap/v3': 'MIT',
  'github.com/go-ole/go-ole': 'MIT',
  'github.com/gobwas/glob': 'MIT',
  'github.com/gofrs/flock': 'BSD-3-Clause',
  'github.com/golang/snappy': 'BSD-3-Clause',
  'github.com/google/uuid': 'BSD-3-Clause',
  'github.com/hashicorp/errwrap': 'MPL-2.0',
  'github.com/hashicorp/go-multierror': 'MPL-2.0',
  'github.com/hashicorp/golang-lru/v2': 'MPL-2.0',
  'github.com/jackpal/gateway': 'BSD-3-Clause',
  'github.com/jackpal/go-nat-pmp': 'Apache-2.0',
  'github.com/jmoiron/sqlx': 'MIT',
  'github.com/julienschmidt/httprouter': 'BSD-3-Clause',
  'github.com/kballard/go-shellquote': 'MIT',
  'github.com/mattn/go-isatty': 'MIT',
  'github.com/mattn/go-sqlite3': 'MIT',
  'github.com/miscreant/miscreant.go': 'MIT',
  'github.com/munnerz/goautoneg': 'BSD-3-Clause',
  'github.com/ncruces/go-strftime': 'MIT',
  'github.com/pierrec/lz4/v4': 'BSD-3-Clause',
  'github.com/pkg/errors': 'BSD-2-Clause',
  'github.com/pmezard/go-difflib': 'BSD-3-Clause',
  'github.com/posener/complete': 'MIT',
  'github.com/prometheus/client_golang': 'Apache-2.0',
  'github.com/prometheus/client_model': 'Apache-2.0',
  'github.com/prometheus/common': 'Apache-2.0',
  'github.com/prometheus/procfs': 'Apache-2.0',
  'github.com/quic-go/quic-go': 'MIT',
  'github.com/rcrowley/go-metrics': 'BSD-2-Clause',
  'github.com/remyoudompheng/bigfft': 'BSD-3-Clause',
  'github.com/riywo/loginshell': 'MIT',
  'github.com/russross/blackfriday/v2': 'BSD-2-Clause',
  'github.com/shirou/gopsutil/v4': 'BSD-3-Clause',
  'github.com/stretchr/objx': 'MIT',
  'github.com/stretchr/testify': 'MIT',
  'github.com/syncthing/notify': 'MIT',
  'github.com/syndtr/goleveldb': 'BSD-2-Clause',
  'github.com/thejerf/suture/v4': 'MIT',
  'github.com/tklauser/go-sysconf': 'BSD-3-Clause',
  'github.com/tklauser/numcpus': 'Apache-2.0',
  'github.com/urfave/cli': 'MIT',
  'github.com/vitrun/qart': '(Apache-2.0 AND BSD-3-Clause)',
  'github.com/willabides/kongplete': 'MIT',
  'github.com/yusufpapurcu/wmi': 'MIT',
  'golang.org/x/crypto': 'BSD-3-Clause',
  'golang.org/x/exp': 'BSD-3-Clause',
  'golang.org/x/net': 'BSD-3-Clause',
  'golang.org/x/sys': 'BSD-3-Clause',
  'golang.org/x/text': 'BSD-3-Clause',
  'golang.org/x/time': 'BSD-3-Clause',
  'google.golang.org/protobuf': 'BSD-3-Clause',
  'gopkg.in/yaml.v3': '(MIT AND Apache-2.0)',
  'modernc.org/libc': 'BSD-3-Clause',
  'modernc.org/mathutil': 'BSD-3-Clause',
  'modernc.org/memory': 'BSD-3-Clause',
  'modernc.org/sqlite': 'BSD-3-Clause',
};

export const deniedLicensePattern =
  /\b(?:AGPL-1\.0|AGPL-3\.0|SSPL-1\.0|BUSL-1\.1)(?:-only|-or-later)?\b/i;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonStream(output) {
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (start === -1) {
      if (/\s/.test(character)) continue;
      if (character !== '{') throw new Error(`go list 输出包含非 JSON 数据：${character}`);
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        values.push(JSON.parse(output.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start !== -1 || depth !== 0 || inString) throw new Error('go list JSON 输出不完整');
  return values;
}

function listTargetModules(target) {
  const output = execFileSync(
    'go',
    [
      'list',
      '-deps',
      '-json',
      '-mod=readonly',
      `-tags=${syncthingMetadata.buildTags.join(',')}`,
      './cmd/syncthing',
    ],
    {
      cwd: syncthingSource,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CGO_ENABLED: syncthingMetadata.cgoByTarget[target.markerId] ? '1' : '0',
        GOARCH: target.goarch,
        GOFLAGS: '-mod=readonly -buildvcs=false',
        GOOS: target.goos,
        GOWORK: 'off',
      },
    },
  );
  const byPath = new Map();
  for (const packageData of parseJsonStream(output)) {
    const module = packageData.Module;
    if (!module || module.Main) continue;
    const normalized = {
      path: module.Path,
      version: module.Version,
      sum: module.Sum ?? null,
      replacement: module.Replace
        ? {
            path: module.Replace.Path,
            version: module.Replace.Version,
            sum: module.Replace.Sum ?? null,
          }
        : null,
      directory: module.Replace?.Dir ?? module.Dir,
    };
    const previous = byPath.get(normalized.path);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      throw new Error(`${target.id} 对 ${normalized.path} 返回了冲突的模块元数据`);
    }
    byPath.set(normalized.path, normalized);
  }
  return [...byPath.values()].sort((left, right) => compare(left.path, right.path));
}

function licenseFiles(directory, modulePath) {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort(compare);
  if (names.length === 0) throw new Error(`${modulePath} 没有根目录 LICENSE/COPYING/NOTICE 文件`);
  return names.map((path) => {
    const content = readFileSync(resolve(directory, path));
    return { path, sha256: sha256Buffer(content), content };
  });
}

function normalizedModule(module, targets) {
  if (typeof module.path !== 'string' || typeof module.version !== 'string') {
    throw new Error('go list 返回了缺少 path/version 的外部模块');
  }
  if (
    (!module.replacement && (typeof module.sum !== 'string' || !module.sum.startsWith('h1:'))) ||
    (module.replacement &&
      (typeof module.replacement.sum !== 'string' || !module.replacement.sum.startsWith('h1:')))
  ) {
    throw new Error(`${module.path}@${module.version} 缺少 go.sum 校验值`);
  }
  const license = reviewedLicenses[module.path];
  if (!license) throw new Error(`${module.path}@${module.version} 尚未进行许可证审核`);
  if (license === 'UNKNOWN' || deniedLicensePattern.test(license)) {
    throw new Error(`${module.path}@${module.version} 使用不允许的许可证：${license}`);
  }
  if (!module.directory) throw new Error(`${module.path}@${module.version} 没有可读取的模块目录`);
  const files = licenseFiles(module.directory, module.path);
  return {
    path: module.path,
    version: module.version,
    sum: module.sum,
    replacement: module.replacement,
    license,
    licenseFiles: files.map(({ path, sha256 }) => ({ path, sha256 })),
    targets,
    noticeFiles: files,
  };
}

export function collectGoModuleArtifacts() {
  assertSyncthingSource();
  const modules = new Map();
  for (const target of goModuleTargets) {
    for (const module of listTargetModules(target)) {
      const previous = modules.get(module.path);
      const identity = {
        path: module.path,
        version: module.version,
        sum: module.sum,
        replacement: module.replacement,
        directory: module.directory,
      };
      if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) {
        throw new Error(`${module.path} 在不同构建目标上解析为不同版本或 replacement`);
      }
      if (previous) previous.targets.push(target.id);
      else modules.set(module.path, { identity, targets: [target.id] });
    }
  }

  const discoveredPaths = [...modules.keys()].sort(compare);
  const reviewedPaths = Object.keys(reviewedLicenses).sort(compare);
  if (JSON.stringify(discoveredPaths) !== JSON.stringify(reviewedPaths)) {
    const missing = discoveredPaths.filter((path) => !reviewedLicenses[path]);
    const stale = reviewedPaths.filter((path) => !modules.has(path));
    throw new Error(
      `Go 模块许可证审核表与实际构建不一致；未审核：${missing.join(', ') || '无'}；已失效：${stale.join(', ') || '无'}`,
    );
  }

  const normalized = discoveredPaths.map((path) => {
    const module = modules.get(path);
    return normalizedModule(module.identity, module.targets);
  });
  const inventory = {
    schemaVersion: 1,
    source: {
      module: 'github.com/syncthing/syncthing',
      version: syncthingMetadata.version,
      commit: syncthingMetadata.commit,
      tree: syncthingMetadata.tree,
      package: './cmd/syncthing',
      buildTags: syncthingMetadata.buildTags,
    },
    targets: goModuleTargets.map(({ id, markerId, goos, goarch }) => ({
      id,
      goos,
      goarch,
      cgoEnabled: syncthingMetadata.cgoByTarget[markerId],
    })),
    modules: normalized.map((module) => ({
      path: module.path,
      version: module.version,
      sum: module.sum,
      replacement: module.replacement,
      license: module.license,
      licenseFiles: module.licenseFiles,
      targets: module.targets,
    })),
  };
  return {
    inventory,
    inventoryText: `${JSON.stringify(inventory, null, 2)}\n`,
    noticesText: renderGoModuleNotices(normalized),
  };
}

function renderGoModuleNotices(modules) {
  const chunks = [
    'KiteSync bundled Syncthing Go module licenses\n',
    '================================================\n\n',
    `Syncthing ${syncthingMetadata.version} is built from the pinned, unmodified source at\n`,
    `${syncthingMetadata.commit}. The sections below contain the complete, unmodified\n`,
    'root LICENSE, COPYING, NOTICE, and COPYRIGHT files shipped by every external Go\n',
    'module linked into any supported KiteSync Syncthing binary. File SHA-256 values\n',
    'are recorded in GO_MODULES.json and repeated here for auditability.\n',
  ];
  for (const module of modules) {
    chunks.push(
      '\n==============================================================================\n',
    );
    chunks.push(`Module: ${module.path}@${module.version}\n`);
    if (module.replacement) {
      chunks.push(
        `Replacement: ${module.replacement.path}@${module.replacement.version} (${module.replacement.sum})\n`,
      );
    }
    chunks.push(`License expression: ${module.license}\n`);
    chunks.push(`Build targets: ${module.targets.join(', ')}\n`);
    for (const file of module.noticeFiles) {
      chunks.push(
        '\n------------------------------------------------------------------------------\n',
      );
      chunks.push(`File: ${file.path}\n`);
      chunks.push(`SHA-256: ${file.sha256}\n`);
      chunks.push(
        '------------------------------------------------------------------------------\n',
      );
      chunks.push(file.content.toString('utf8'));
      if (file.content.length > 0 && file.content.at(-1) !== 0x0a) chunks.push('\n');
    }
  }
  return chunks.join('');
}

export function loadGoModuleInventory() {
  return JSON.parse(readFileSync(goModuleInventoryPath, 'utf8'));
}

export function verifyGoModuleArtifacts() {
  const expected = collectGoModuleArtifacts();
  const actualInventory = readFileSync(goModuleInventoryPath, 'utf8');
  const actualNotices = readFileSync(goModuleNoticesPath, 'utf8');
  if (actualInventory !== expected.inventoryText) {
    throw new Error('vendor/syncthing/GO_MODULES.json 已过期；请运行 bun run licenses:generate');
  }
  if (actualNotices !== expected.noticesText) {
    throw new Error(
      'vendor/syncthing/SYNCTHING_THIRD_PARTY_LICENSES.txt 已过期；请运行 bun run licenses:generate',
    );
  }
  return expected.inventory;
}
