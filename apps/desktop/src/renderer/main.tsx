import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Device, SyncSpace } from '@kitesync/contracts';
import { Badge, Button, Card, EmptyState, formatBytes } from '@kitesync/ui';
import './styles.css';

const hostBridge = window.kitesync;
const developmentCredentials =
  import.meta.env.DEV &&
  import.meta.env.VITE_KITESYNC_DEV_USERNAME &&
  import.meta.env.VITE_KITESYNC_DEV_PASSWORD
    ? {
        username: import.meta.env.VITE_KITESYNC_DEV_USERNAME,
        password: import.meta.env.VITE_KITESYNC_DEV_PASSWORD,
      }
    : undefined;

function App() {
  const [account, setAccount] = useState<any>();
  const [device, setDevice] = useState<Device | null>();
  const [offers, setOffers] = useState<SyncSpace[]>([]);
  const [bindings, setBindings] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [autoStart, setAutoStart] = useState(false);
  const [error, setError] = useState('');
  const request = hostBridge.request;
  async function refresh() {
    try {
      const [accountResult, deviceResult, bindingResult, activityResult] = await Promise.all([
        request<any>('/api/v1/account'),
        request<any>('/api/v1/device'),
        request<any>('/api/v1/directory-bindings'),
        request<any>('/api/v1/activity'),
      ]);
      setAccount(accountResult.account);
      setDevice(deviceResult.device);
      setBindings(bindingResult.items);
      setActivity(activityResult.items);
      if (accountResult.account)
        setOffers((await request<{ items: SyncSpace[] }>('/api/v1/offers')).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  useEffect(() => {
    void refresh();
    void window.kitesync.getAutoStart().then(setAutoStart);
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      await request('/api/v1/account/login', {
        method: 'POST',
        body: {
          serverUrl: data.get('serverUrl'),
          username: data.get('username'),
          password: data.get('password'),
        },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await request('/api/v1/device/register', {
        method: 'POST',
        body: {
          displayName: data.get('displayName'),
          platform: window.kitesync.platform === 'darwin' ? 'macos' : window.kitesync.platform,
        },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function bind(space: SyncSpace) {
    try {
      const grant = await window.kitesync.chooseDirectory();
      if (!grant) return;
      await request('/api/v1/directory-bindings', {
        method: 'POST',
        body: { syncSpaceId: space.id, grantId: grant.grantId },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function mutateBinding(binding: any, action: 'pause' | 'resume' | 'unbind') {
    try {
      await request(
        `/api/v1/directory-bindings/${binding.id}${action === 'unbind' ? '' : `/${action}`}`,
        {
          method: action === 'unbind' ? 'DELETE' : 'POST',
        },
      );
      if (action === 'unbind') await window.kitesync.revokeGrant(binding.grantId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!account)
    return (
      <main className="welcome">
        <div className="intro">
          <span className="mark">K</span>
          <h1>KiteSync</h1>
          <p>连接你的局域网 KiteSync 服务器，让文件在各台设备之间可靠流转。</p>
        </div>
        <Card>
          <h2>连接服务器</h2>
          <form onSubmit={(event) => void login(event)}>
            <label>
              服务器地址
              <input name="serverUrl" defaultValue="http://127.0.0.1:3000" required />
            </label>
            <label>
              用户名
              <input
                name="username"
                defaultValue={developmentCredentials?.username}
                autoComplete="username"
                required
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                defaultValue={developmentCredentials?.password}
                autoComplete="current-password"
                required
              />
            </label>
            {error && <p className="error">{error}</p>}
            <Button>登录</Button>
          </form>
        </Card>
      </main>
    );
  if (!device)
    return (
      <main className="center">
        <Card>
          <span className="mark">K</span>
          <h2>为这台设备命名</h2>
          <p>注册后，需要管理员在 Web 控制台批准。</p>
          <form onSubmit={(event) => void register(event)}>
            <label>
              设备名称
              <input name="displayName" defaultValue={navigator.platform} required />
            </label>
            <Button>注册设备</Button>
          </form>
          {error && <p className="error">{error}</p>}
        </Card>
      </main>
    );

  return (
    <div className="desktop">
      <header>
        <div className="brand">
          <span className="mark">K</span>
          <b>KiteSync</b>
        </div>
        <div className="device">
          <Badge tone={device.state === 'active' ? 'good' : 'warn'}>
            {device.state === 'active' ? '已连接' : '等待管理员批准'}
          </Badge>
          <span>{device.displayName}</span>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-heading">
            <div>
              <p>你好，{account.displayName}</p>
              <h1>你的同步空间</h1>
            </div>
            <div className="host-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(event) =>
                    void window.kitesync.setAutoStart(event.target.checked).then(setAutoStart)
                  }
                />
                开机启动
              </label>
              <button
                className="secondary-button"
                onClick={() => void window.kitesync.exportDiagnostics()}
              >
                导出诊断
              </button>
              <button
                className="secondary-button"
                onClick={() =>
                  void request<any>('/api/v1/conflicts')
                    .then((result) => setConflicts(result.items))
                    .catch((cause) =>
                      setError(cause instanceof Error ? cause.message : String(cause)),
                    )
                }
              >
                扫描冲突
              </button>
            </div>
          </div>
          <span>所有数据经由组织 Hub，同步时不使用其他桌面设备。</span>
        </section>
        {error && <p className="error banner">{error}</p>}
        <div className="space-list">
          {offers.length === 0 ? (
            <EmptyState title="暂无空间邀请" detail="空间创建或共享给你后，会出现在这里。" />
          ) : (
            offers.map((space) => {
              const bound = bindings.find((item) => item.syncSpaceId === space.id);
              const status = activity.find((item) => item.syncSpaceId === space.id);
              return (
                <Card key={space.id} className="space">
                  <div>
                    <h3>{space.label}</h3>
                    <p>
                      {formatBytes(space.usedBytes)} / {formatBytes(space.quotaBytes)}
                    </p>
                    {status && (
                      <small>
                        {status.status} · 剩余 {status.needFiles ?? 0} 个文件 /{' '}
                        {formatBytes(status.needBytes ?? 0)} · 磁盘可用{' '}
                        {formatBytes(status.diskFreeBytes ?? 0)}
                      </small>
                    )}
                  </div>
                  {bound ? (
                    <div className="binding-actions">
                      <Badge tone={bound.state === 'syncing' ? 'good' : 'neutral'}>
                        {bound.state === 'syncing' ? '同步中' : bound.state}
                      </Badge>
                      <button onClick={() => void window.kitesync.openGrant(bound.grantId)}>
                        打开目录
                      </button>
                      <button
                        onClick={() =>
                          void mutateBinding(bound, bound.state === 'paused' ? 'resume' : 'pause')
                        }
                      >
                        {bound.state === 'paused' ? '恢复' : '暂停'}
                      </button>
                      <button
                        className="danger-button"
                        title="解除后保留本地文件"
                        onClick={() => void mutateBinding(bound, 'unbind')}
                      >
                        解除绑定
                      </button>
                    </div>
                  ) : (
                    <Button disabled={device.state !== 'active'} onClick={() => void bind(space)}>
                      选择本地目录
                    </Button>
                  )}
                </Card>
              );
            })
          )}
        </div>
        {conflicts.length > 0 && (
          <section className="conflicts">
            <h2>冲突副本</h2>
            <p>保留了双方文件，请打开目录后人工选择需要的内容；KiteSync 不自动合并。</p>
            {conflicts.slice(0, 100).map((conflict) => (
              <button
                key={`${conflict.grantId}:${conflict.relativePath}`}
                onClick={() => void window.kitesync.openGrant(conflict.grantId)}
              >
                <span>{conflict.relativePath}</span>
                <small>
                  {formatBytes(conflict.sizeBytes)} ·{' '}
                  {new Date(conflict.modifiedAt).toLocaleString()}
                </small>
              </button>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function StartupFailure() {
  return (
    <main className="startup-failure">
      <Card>
        <span className="mark">K</span>
        <h1>KiteSync 无法启动</h1>
        <p>桌面安全桥接加载失败。请退出 KiteSync 后重新启动，并查看终端中的启动日志。</p>
      </Card>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(hostBridge ? <App /> : <StartupFailure />);
