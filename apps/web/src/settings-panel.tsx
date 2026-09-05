import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card } from '@kitesync/ui';
import type {
  IgnoredDevice,
  IgnoredFolder,
  NodeSettings,
  UpdateNodeSettings,
} from '@kitesync/contracts';
import { ApiError, api } from './api.js';
import { useUnsavedChanges } from './unsaved-changes.js';

type Draft = {
  nodeName: string;
  lanAccessEnabled: boolean;
  allowedOrigins: string;
  trustedProxies: string;
  versioningDays: string;
};

function draftFrom(settings: NodeSettings): Draft {
  return {
    nodeName: settings.nodeName,
    lanAccessEnabled: settings.lanAccessEnabled,
    allowedOrigins: settings.allowedOrigins.join('\n'),
    trustedProxies: settings.trustedProxies.join('\n'),
    versioningDays: String(settings.versioningDays),
  };
}

export function SettingsPanel({ onPasswordChanged }: { onPasswordChanged: () => void }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const pendingFolders = useQuery({
    queryKey: ['folders', 'pending'],
    queryFn: api.pendingFolders,
  });
  const pendingDevices = useQuery({
    queryKey: ['devices', 'pending'],
    queryFn: api.pendingDevices,
  });
  const diagnostics = useQuery({
    queryKey: ['diagnostics', 'summary'],
    queryFn: api.diagnosticSummary,
    refetchInterval: 30_000,
  });
  const logs = useQuery({
    queryKey: ['diagnostics', 'logs'],
    queryFn: () => api.diagnosticLogs(),
  });

  if (settings.isLoading) return <Card className="quiet-card">正在读取设置…</Card>;
  if (!settings.data) {
    return (
      <Card>
        <p className="form-error">{errorMessage(settings.error)}</p>
        <Button className="secondary-button" onClick={() => void settings.refetch()}>
          重试
        </Button>
      </Card>
    );
  }

  return (
    <>
      {settings.isError && (
        <Card className="stale-banner" role="alert">
          <strong>设置暂时无法刷新，以下为最后一次成功数据</strong>
          <span>最后成功：{new Date(settings.dataUpdatedAt).toLocaleString('zh-CN')}</span>
          <Button className="secondary-button" onClick={() => void settings.refetch()}>
            重新连接
          </Button>
        </Card>
      )}
      <SettingsForm
        settings={settings.data}
        ignoredDevices={pendingDevices.data?.ignored ?? []}
        ignoredFolders={pendingFolders.data?.ignored ?? []}
        diagnostic={diagnostics.data}
        diagnosticError={diagnostics.error ?? logs.error}
        logs={logs.data?.items ?? []}
        onPasswordChanged={onPasswordChanged}
      />
    </>
  );
}

function SettingsForm({
  settings,
  ignoredDevices,
  ignoredFolders,
  diagnostic,
  diagnosticError,
  logs,
  onPasswordChanged,
}: {
  settings: NodeSettings;
  ignoredDevices: IgnoredDevice[];
  ignoredFolders: IgnoredFolder[];
  diagnostic: Awaited<ReturnType<typeof api.diagnosticSummary>> | undefined;
  diagnosticError: unknown;
  logs: Awaited<ReturnType<typeof api.diagnosticLogs>>['items'];
  onPasswordChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftFrom(settings));
  const [dirty, setDirty] = useState<Set<keyof Draft>>(() => new Set());
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [message, setMessage] = useState('更改只会应用到当前节点');
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const latest = useMemo(() => draftFrom(settings), [settings]);
  const source = useRef(latest);

  useEffect(() => {
    setDraft((current) => {
      const next = { ...current };
      let changedWhileEditing = false;
      for (const key of Object.keys(latest) as Array<keyof Draft>) {
        if (dirty.has(key)) {
          if (source.current[key] !== latest[key]) changedWhileEditing = true;
        } else {
          Object.assign(next, { [key]: latest[key] });
        }
      }
      if (changedWhileEditing) setRemoteChanged(true);
      else if (!dirty.size) setRemoteChanged(false);
      return next;
    });
    source.current = latest;
  }, [dirty, latest]);

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    const next = new Set(dirty);
    if (value === latest[key]) next.delete(key);
    else next.add(key);
    setDirty(next);
    setMessage(next.size ? '有未保存的更改' : '没有未保存的更改');
  }

  useUnsavedChanges(dirty.size > 0);

  const update = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (result, variables) => {
      queryClient.setQueryData(['settings'], result);
      void queryClient.invalidateQueries({ queryKey: ['node'] });
      setDirty(new Set());
      setRemoteChanged(false);
      setFieldError({});
      setMessage(
        variables.lanAccessEnabled !== undefined &&
          variables.lanAccessEnabled !== settings.lanAccessEnabled
          ? '访问范围已更改；若页面断开，请使用新的节点地址重新打开。'
          : '设置已保存',
      );
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: Record<string, string> = {};
    const rawOrigins = lines(draft.allowedOrigins);
    const invalidOrigin = rawOrigins.find((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.protocol !== 'https:' ||
          Boolean(url.username || url.password || url.search || url.hash) ||
          (url.pathname !== '/' && url.pathname !== '')
        );
      } catch {
        return true;
      }
    });
    if (!draft.nodeName.trim()) errors.nodeName = '请输入节点名称';
    if (invalidOrigin) errors.allowedOrigins = `“${invalidOrigin}”不是有效的 HTTPS 来源`;
    const versioningDays = Number(draft.versioningDays);
    if (
      !draft.versioningDays.trim() ||
      !Number.isInteger(versioningDays) ||
      versioningDays < 0 ||
      versioningDays > 3650
    ) {
      errors.versioningDays = '请输入 0 到 3650 之间的整数';
    }
    setFieldError(errors);
    if (Object.keys(errors).length) return;

    const input: UpdateNodeSettings = {};
    if (dirty.has('nodeName')) input.nodeName = draft.nodeName.trim();
    if (dirty.has('lanAccessEnabled')) input.lanAccessEnabled = draft.lanAccessEnabled;
    if (dirty.has('allowedOrigins')) {
      input.allowedOrigins = [...new Set(rawOrigins.map((origin) => new URL(origin).origin))];
    }
    if (dirty.has('trustedProxies')) input.trustedProxies = lines(draft.trustedProxies);
    if (dirty.has('versioningDays')) input.versioningDays = versioningDays;
    if (!Object.keys(input).length) {
      setMessage('没有需要保存的更改');
      return;
    }
    update.mutate(input);
  }

  const conflict = update.error instanceof ApiError && update.error.status === 412;

  return (
    <div className="settings-stack">
      <form className="settings-stack" onSubmit={submit}>
        <Card>
          <div className="settings-heading">
            <div>
              <h2>节点</h2>
              <p>这个名称会显示在已配对设备上。</p>
            </div>
            <Badge>{settings.nodeName}</Badge>
          </div>
          <div className="form-grid two-columns">
            <label>
              节点名称
              <input
                name="display-name"
                required
                maxLength={64}
                value={draft.nodeName}
                onChange={(event) => change('nodeName', event.currentTarget.value)}
                aria-invalid={Boolean(fieldError.nodeName)}
              />
              {fieldError.nodeName && <small className="field-error">{fieldError.nodeName}</small>}
            </label>
            <label>
              管理界面端口
              <input value={settings.uiPort} readOnly aria-readonly="true" />
              <small>端口由启动配置决定。</small>
            </label>
          </div>
          <label>
            默认历史版本保留天数
            <input
              className="short-input"
              type="number"
              required
              min="0"
              max="3650"
              value={draft.versioningDays}
              onChange={(event) => change('versioningDays', event.currentTarget.value)}
            />
            {fieldError.versioningDays && (
              <small className="field-error">{fieldError.versioningDays}</small>
            )}
            <small>设为 0 会关闭之后新建或接受文件夹的版本保留。</small>
          </label>
        </Card>

        <Card>
          <div className="settings-heading">
            <div>
              <h2>局域网访问</h2>
              <p>允许同一局域网中的浏览器打开管理界面。</p>
            </div>
            <Badge tone={draft.lanAccessEnabled ? 'warn' : 'good'}>
              {draft.lanAccessEnabled ? 'LAN 已开放' : `仅 ${settings.nodeName}`}
            </Badge>
          </div>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draft.lanAccessEnabled}
              onChange={(event) => change('lanAccessEnabled', event.currentTarget.checked)}
            />
            <span className="switch" aria-hidden="true" />
            <span>
              <b>允许 LAN 访问</b>
              <small>直接 LAN HTTP 未加密，请只在可信网络中使用。</small>
            </span>
          </label>
          <label>
            允许的 HTTPS 来源
            <textarea
              rows={4}
              value={draft.allowedOrigins}
              onChange={(event) => change('allowedOrigins', event.currentTarget.value)}
              placeholder={'https://sync.example.com\nhttps://kitesync.home.example'}
              aria-invalid={Boolean(fieldError.allowedOrigins)}
            />
            {fieldError.allowedOrigins && (
              <small className="field-error">{fieldError.allowedOrigins}</small>
            )}
          </label>
        </Card>

        <Card>
          <div className="settings-heading">
            <div>
              <h2>反向代理</h2>
              <p>仅填写你管理的 HTTPS 反向代理地址。</p>
            </div>
          </div>
          <label>
            可信代理地址
            <textarea
              rows={3}
              value={draft.trustedProxies}
              onChange={(event) => change('trustedProxies', event.currentTarget.value)}
              placeholder={'127.0.0.1\n192.168.1.10'}
            />
            <small>每行一个 IP、CIDR 或 loopback。</small>
          </label>
        </Card>

        {remoteChanged && (
          <p className="notice-banner" role="status">
            服务器设置在编辑期间发生了变化；未编辑字段已更新，草稿字段仍保留。
          </p>
        )}
        {conflict && (
          <Card className="conflict-card" role="alert">
            <strong>另一页面已先保存设置</strong>
            <p>当前草稿没有覆盖服务器内容。请重新加载，或保留草稿后逐项核对。</p>
            <div className="row-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setDirty(new Set());
                  void queryClient.invalidateQueries({ queryKey: ['settings'] });
                }}
              >
                重新加载
              </button>
              <Button
                type="button"
                onClick={() => void queryClient.invalidateQueries({ queryKey: ['settings'] })}
              >
                保留草稿重新核对
              </Button>
            </div>
          </Card>
        )}
        {update.error && !conflict && <p className="form-error">{errorMessage(update.error)}</p>}
        <div className="settings-savebar">
          <span aria-live="polite">{message}</span>
          <Button disabled={update.isPending || !dirty.size}>
            {update.isPending ? '正在保存…' : '保存设置'}
          </Button>
        </div>
      </form>

      <PasswordCard onChanged={onPasswordChanged} />
      <IgnoredCards ignoredDevices={ignoredDevices} ignoredFolders={ignoredFolders} />
      <Card className="fixed-security-card">
        <div className="shield">✓</div>
        <div>
          <h2>固定的网络安全策略</h2>
          <p>局域网发现保持开启；全局发现、公共 Relay、NAT 穿透、遥测和自动升级始终关闭。</p>
        </div>
      </Card>
      <Card>
        <div className="settings-heading">
          <div>
            <h2>诊断</h2>
            <p>导出内容使用白名单，并移除凭据、绝对路径和设备标识。</p>
          </div>
          <a className="ghost-button" href={api.diagnosticExportUrl()} download>
            下载诊断 JSON
          </a>
        </div>
        {diagnostic?.engine && diagnostic.counts ? (
          <dl className="detail-list">
            <div>
              <dt>同步引擎</dt>
              <dd>
                {diagnostic.engine.available ? `可用 · ${diagnostic.engine.version}` : '不可用'}
              </dd>
            </div>
            <div>
              <dt>文件夹</dt>
              <dd>
                {diagnostic.counts.folders} 个，{diagnostic.counts.folderErrors} 个需要处理
              </dd>
            </div>
            <div>
              <dt>连接设备</dt>
              <dd>
                {diagnostic.counts.connectedDevices} / {diagnostic.counts.devices}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="muted-line">正在读取诊断摘要…</p>
        )}
        {Boolean(diagnosticError) && <p className="form-error">{errorMessage(diagnosticError)}</p>}
        {logs.length > 0 && (
          <details className="diagnostic-logs">
            <summary>最近节点事件（{logs.length}）</summary>
            {logs.map((entry) => (
              <div key={`${entry.timestamp}:${entry.message}`}>
                <time>{formatDate(entry.timestamp)}</time>
                <span>{entry.message}</span>
              </div>
            ))}
          </details>
        )}
      </Card>
    </div>
  );
}

function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  useUnsavedChanges(Boolean(currentPassword || newPassword || confirmation));
  const change = useMutation({ mutationFn: api.changePassword, onSuccess: onChanged });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 12) return setError('新密码至少需要 12 个字符');
    if (newPassword !== confirmation) return setError('两次输入的新密码不一致');
    setError('');
    change.mutate({ currentPassword, newPassword });
  }
  return (
    <Card>
      <div className="settings-heading">
        <div>
          <h2>修改管理密码</h2>
          <p>成功后全部旧会话和未使用的本机打开令牌会立即失效。</p>
        </div>
      </div>
      <form className="password-form" onSubmit={submit}>
        <label>
          当前密码
          <input
            required
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.currentTarget.value)}
          />
        </label>
        <label>
          新密码
          <input
            required
            type="password"
            minLength={12}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.currentTarget.value)}
          />
        </label>
        <label>
          确认新密码
          <input
            required
            type="password"
            minLength={12}
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
          />
        </label>
        <Button disabled={change.isPending}>{change.isPending ? '正在修改…' : '修改密码'}</Button>
      </form>
      {(error || change.error) && (
        <p className="form-error">{error || errorMessage(change.error)}</p>
      )}
    </Card>
  );
}

function IgnoredCards({
  ignoredDevices,
  ignoredFolders,
}: {
  ignoredDevices: IgnoredDevice[];
  ignoredFolders: IgnoredFolder[];
}) {
  const queryClient = useQueryClient();
  const unignoreDevice = useMutation({
    mutationFn: api.unignoreDevice,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['devices', 'pending'] }),
  });
  const unignoreFolder = useMutation({
    mutationFn: ({ deviceId, folderId }: { deviceId: string; folderId: string }) =>
      api.unignoreFolder(deviceId, folderId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['folders', 'pending'] }),
  });
  return (
    <>
      {ignoredDevices.length > 0 && (
        <Card>
          <div className="settings-heading">
            <div>
              <h2>已忽略的设备</h2>
              <p>允许后，对方再次请求时会重新询问。</p>
            </div>
            <Badge>{ignoredDevices.length}</Badge>
          </div>
          <div className="ignored-folder-list">
            {ignoredDevices.map((device) => (
              <div key={device.id}>
                <span>
                  <b>{device.name}</b>
                  <code>{device.id}</code>
                </span>
                <button onClick={() => unignoreDevice.mutate(device.id)}>允许重新配对</button>
              </div>
            ))}
          </div>
        </Card>
      )}
      {ignoredFolders.length > 0 && (
        <Card>
          <div className="settings-heading">
            <div>
              <h2>已忽略的文件夹邀请</h2>
              <p>清除后，对方再次邀请时会重新询问。</p>
            </div>
            <Badge>{ignoredFolders.length}</Badge>
          </div>
          <div className="ignored-folder-list">
            {ignoredFolders.map((folder) => (
              <div key={`${folder.deviceId}:${folder.folderId}`}>
                <span>
                  <b>{folder.label}</b>
                  <small>{folder.deviceName}</small>
                </span>
                <button onClick={() => unignoreFolder.mutate(folder)}>清除忽略</button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function lines(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : '操作失败，请重试';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
