import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card } from '@kitesync/ui';
import type { IgnoredDevice, IgnoredFolder, NodeSettings } from '@kitesync/contracts';
import { api } from './api.js';

export function SettingsPanel() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const pendingFolders = useQuery({
    queryKey: ['folders', 'pending'],
    queryFn: api.pendingFolders,
  });
  const pendingDevices = useQuery({
    queryKey: ['devices', 'pending'],
    queryFn: api.pendingDevices,
  });

  if (settings.isLoading) return <Card className="quiet-card">正在读取设置…</Card>;
  if (settings.isError) {
    return (
      <Card>
        <p className="form-error">{errorMessage(settings.error)}</p>
      </Card>
    );
  }
  if (!settings.data) return null;

  return (
    <SettingsForm
      key={settings.data.nodeName}
      settings={settings.data}
      ignoredDevices={pendingDevices.data?.ignored ?? []}
      ignoredFolders={pendingFolders.data?.ignored ?? []}
    />
  );
}

function SettingsForm({
  settings,
  ignoredDevices,
  ignoredFolders,
}: {
  settings: NodeSettings;
  ignoredDevices: IgnoredDevice[];
  ignoredFolders: IgnoredFolder[];
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [reconnectNotice, setReconnectNotice] = useState(false);
  const update = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (result) => {
      queryClient.setQueryData(['settings'], result);
      void queryClient.invalidateQueries({ queryKey: ['node'] });
      if (result.lanAccessEnabled !== settings.lanAccessEnabled) setReconnectNotice(true);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    },
  });
  const unignore = useMutation({
    mutationFn: ({ deviceId, folderId }: { deviceId: string; folderId: string }) =>
      api.unignoreFolder(deviceId, folderId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['folders', 'pending'] }),
  });
  const unignoreDevice = useMutation({
    mutationFn: api.unignoreDevice,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['devices', 'pending'] }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const rawOrigins = lines(form.get('allowedOrigins'));
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
    if (invalidOrigin) {
      setError(`“${invalidOrigin}”不是有效的 HTTPS 来源`);
      return;
    }
    const allowedOrigins = [...new Set(rawOrigins.map((origin) => new URL(origin).origin))];

    update.mutate({
      nodeName: String(form.get('nodeName') ?? '').trim(),
      lanAccessEnabled: form.get('lanAccessEnabled') === 'on',
      allowedOrigins,
      trustedProxies: lines(form.get('trustedProxies')),
      versioningDays: Number(form.get('versioningDays')),
    });
  }

  return (
    <form className="settings-stack" onSubmit={submit}>
      <Card>
        <div className="settings-heading">
          <div>
            <h2>节点</h2>
            <p>这个名称会显示在已配对设备上。</p>
          </div>
          <Badge>本机</Badge>
        </div>
        <div className="form-grid two-columns">
          <label>
            节点名称
            <input name="nodeName" required maxLength={64} defaultValue={settings.nodeName} />
          </label>
          <label>
            管理界面端口
            <input value={settings.uiPort} readOnly aria-readonly="true" />
            <small>端口由启动配置决定，不能在网页中修改。</small>
          </label>
        </div>
        <label>
          默认历史版本保留天数
          <input
            className="short-input"
            name="versioningDays"
            type="number"
            min="0"
            max="3650"
            defaultValue={settings.versioningDays}
          />
          <small>设为 0 可关闭之后新建或接受文件夹时的版本保留。</small>
        </label>
      </Card>

      <Card>
        <div className="settings-heading">
          <div>
            <h2>局域网访问</h2>
            <p>允许同一局域网中的浏览器打开此管理界面。</p>
          </div>
          <Badge tone={settings.lanAccessEnabled ? 'warn' : 'good'}>
            {settings.lanAccessEnabled ? 'LAN 已开放' : '仅本机'}
          </Badge>
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            name="lanAccessEnabled"
            defaultChecked={settings.lanAccessEnabled}
          />
          <span className="switch" aria-hidden="true" />
          <span>
            <b>允许 LAN 访问</b>
            <small>启用后仍需管理密码；请只在可信网络中使用。</small>
          </span>
        </label>
        <label>
          允许的 HTTPS 来源
          <textarea
            name="allowedOrigins"
            rows={4}
            defaultValue={settings.allowedOrigins.join('\n')}
            placeholder={'https://sync.example.com\nhttps://kitesync.home.example'}
          />
          <small>每行一个完整来源。为避免明文凭据，不接受 HTTP 公共来源。</small>
        </label>
      </Card>

      <Card>
        <div className="settings-heading">
          <div>
            <h2>反向代理</h2>
            <p>仅当 KiteSync 确实位于你管理的 HTTPS 反向代理之后时填写。</p>
          </div>
        </div>
        <label>
          可信代理地址
          <textarea
            name="trustedProxies"
            rows={3}
            defaultValue={settings.trustedProxies.join('\n')}
            placeholder={'127.0.0.1\n192.168.1.10'}
          />
          <small>每行一个 IP 或 CIDR。错误信任会让访问控制使用伪造的客户端地址。</small>
        </label>
      </Card>

      <Card className="fixed-security-card">
        <div className="shield">✓</div>
        <div>
          <h2>固定的网络安全策略</h2>
          <p>局域网发现保持开启；全局发现、公共 Relay 和自动 NAT 穿透始终关闭，不能从网页启用。</p>
        </div>
      </Card>

      {ignoredDevices.length > 0 && (
        <Card>
          <div className="settings-heading">
            <div>
              <h2>已忽略的设备</h2>
              <p>允许重新配对后，对方再次请求连接时会重新询问。</p>
            </div>
            <Badge>{ignoredDevices.length}</Badge>
          </div>
          <div className="ignored-folder-list">
            {ignoredDevices.map((device) => (
              <div key={device.id}>
                <span>
                  <b>{device.name}</b>
                  <small>短指纹：{deviceFingerprint(device.id)}</small>
                  <code>{device.id}</code>
                </span>
                <button
                  type="button"
                  disabled={unignoreDevice.isPending}
                  onClick={() => unignoreDevice.mutate(device.id)}
                >
                  允许重新配对
                </button>
              </div>
            ))}
          </div>
          {unignoreDevice.error && (
            <p className="form-error">{errorMessage(unignoreDevice.error)}</p>
          )}
        </Card>
      )}

      {ignoredFolders.length > 0 && (
        <Card>
          <div className="settings-heading">
            <div>
              <h2>已忽略的文件夹邀请</h2>
              <p>清除后，对方再次发出邀请时会重新询问。</p>
            </div>
            <Badge>{ignoredFolders.length}</Badge>
          </div>
          <div className="ignored-folder-list">
            {ignoredFolders.map((folder) => (
              <div key={`${folder.deviceId}:${folder.folderId}`}>
                <span>
                  <b>{folder.label}</b>
                  <small>
                    {folder.deviceName} · {folder.folderId}
                  </small>
                </span>
                <button
                  type="button"
                  disabled={unignore.isPending}
                  onClick={() =>
                    unignore.mutate({ deviceId: folder.deviceId, folderId: folder.folderId })
                  }
                >
                  清除忽略
                </button>
              </div>
            ))}
          </div>
          {unignore.error && <p className="form-error">{errorMessage(unignore.error)}</p>}
        </Card>
      )}

      {(error || update.error) && (
        <p className="form-error">{error || errorMessage(update.error)}</p>
      )}
      <div className="settings-savebar">
        <span>
          {reconnectNotice
            ? '访问范围已更改；若页面断开，请使用新的节点地址重新打开。'
            : saved
              ? '设置已保存'
              : '更改只会应用到当前节点'}
        </span>
        <Button disabled={update.isPending}>{update.isPending ? '正在保存…' : '保存设置'}</Button>
      </div>
    </form>
  );
}

function lines(value: FormDataEntryValue | null) {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : '操作失败，请重试';
}

function deviceFingerprint(id: string) {
  const compact = id.replaceAll('-', '').slice(0, 12);
  return compact.length > 6 ? `${compact.slice(0, 6)} ${compact.slice(6)}` : compact;
}
