import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, formatBytes } from '@kitesync/ui';
import type { NodeInfo } from '@kitesync/contracts';
import { api } from './api.js';
import { DevicesPanel } from './devices-panel.js';
import { FoldersPanel } from './folders-panel.js';
import { SettingsPanel } from './settings-panel.js';
import { confirmDiscardChanges } from './unsaved-changes.js';

type Section = 'overview' | 'devices' | 'folders' | 'settings';
type FolderTab = 'files' | 'versions' | 'settings';

interface AppLocation {
  section: Section;
  folderId?: string;
  tab?: FolderTab;
  path?: string;
}

function readLocation(): AppLocation {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const section = (['overview', 'devices', 'folders', 'settings'] as const).includes(
    parts[0] as Section,
  )
    ? (parts[0] as Section)
    : 'overview';
  if (section !== 'folders' || !parts[1]) return { section };
  const tab = (['files', 'versions', 'settings'] as const).includes(parts[2] as FolderTab)
    ? (parts[2] as FolderTab)
    : 'files';
  return {
    section,
    folderId: decodeURIComponent(parts[1]),
    tab,
    path: new URLSearchParams(window.location.search).get('path') ?? '',
  };
}

const sectionCopy: Record<Section, { title: string; detail: string }> = {
  overview: { title: '节点总览', detail: '当前电脑的同步状态一目了然' },
  devices: { title: '设备', detail: '发现、配对并管理局域网设备' },
  folders: { title: '同步文件夹', detail: '选择要同步的目录和目标设备' },
  settings: { title: '设置', detail: '调整本机节点和管理界面的访问方式' },
};

export function Dashboard({
  initialNode,
  onLogout,
}: {
  initialNode: NodeInfo;
  onLogout: () => void;
}) {
  const [location, setLocation] = useState(readLocation);
  const currentUrl = useRef(`${window.location.pathname}${window.location.search}`);
  const queryClient = useQueryClient();
  const node = useQuery({ queryKey: ['node'], queryFn: api.node, initialData: initialNode });

  useEffect(() => {
    const update = () => {
      if (!confirmDiscardChanges()) {
        window.history.pushState(null, '', currentUrl.current);
        return;
      }
      currentUrl.current = `${window.location.pathname}${window.location.search}`;
      setLocation(readLocation());
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  function navigate(next: AppLocation) {
    if (!confirmDiscardChanges()) return;
    const pathname =
      next.section === 'folders' && next.folderId
        ? `/folders/${encodeURIComponent(next.folderId)}/${next.tab ?? 'files'}`
        : `/${next.section}`;
    const query = next.path ? `?path=${encodeURIComponent(next.path)}` : '';
    window.history.pushState(null, '', pathname + query);
    currentUrl.current = pathname + query;
    setLocation(readLocation());
  }

  const refresh = () => void queryClient.invalidateQueries();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="logo">
          <span className="brand-mark">K</span>
          <div>
            <b>KiteSync</b>
            <small>{node.data.name}</small>
          </div>
        </div>
        <nav aria-label="主导航">
          <NavButton
            id="overview"
            label="总览"
            icon="⌂"
            current={location.section}
            onSelect={(section) => navigate({ section })}
          />
          <NavButton
            id="devices"
            label="设备"
            icon="◇"
            current={location.section}
            onSelect={(section) => navigate({ section })}
          />
          <NavButton
            id="folders"
            label="文件夹"
            icon="▱"
            current={location.section}
            onSelect={(section) => navigate({ section })}
          />
          <NavButton
            id="settings"
            label="设置"
            icon="⚙"
            current={location.section}
            onSelect={(section) => navigate({ section })}
          />
        </nav>
        <div className="node-summary">
          <span
            className={`status-dot ${node.isError || node.data.engineStatus === 'unavailable' ? 'status-dot--error' : ''}`}
          />
          <div>
            <strong>{node.data.name}</strong>
            <small>
              {node.isError
                ? '节点服务连接异常'
                : node.data.engineStatus === 'unavailable'
                  ? '同步引擎正在重连'
                  : '节点服务已连接'}
            </small>
          </div>
        </div>
        <button className="logout-button" onClick={() => void api.logout().finally(onLogout)}>
          锁定管理界面
        </button>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">{sectionCopy[location.section].detail}</p>
            <h1>{sectionCopy[location.section].title}</h1>
          </div>
          <div className="header-actions">
            <button className="identity-chip" onClick={() => navigate({ section: 'devices' })}>
              {node.data.name}
            </button>
            <Button className="secondary-button" onClick={refresh}>
              刷新状态
            </Button>
            <button className="header-lock" onClick={() => void api.logout().finally(onLogout)}>
              锁定
            </button>
          </div>
        </header>

        {(node.isError || node.data.engineStatus === 'unavailable') && (
          <Card className="stale-banner" role="alert">
            <strong>
              {node.isError ? '节点服务连接已中断，页面显示的是旧数据' : node.data.engineError}
            </strong>
            <span>
              最后成功状态：
              {new Date(node.data.statusUpdatedAt ?? node.dataUpdatedAt).toLocaleString('zh-CN')}
            </span>
            <Button className="secondary-button" onClick={() => void node.refetch()}>
              重新连接
            </Button>
          </Card>
        )}

        {location.section === 'overview' && (
          <Overview node={node.data} onNavigate={(section) => navigate({ section })} />
        )}
        {location.section === 'devices' && <DevicesPanel node={node.data} />}
        {location.section === 'folders' && (
          <FoldersPanel
            canRevealFiles={node.data.canRevealFiles}
            canPickDirectories={node.data.canPickDirectories}
            nodeName={node.data.name}
            {...(location.folderId ? { selectedFolderId: location.folderId } : {})}
            selectedTab={location.tab ?? 'files'}
            selectedPath={location.path ?? ''}
            onNavigate={(folderId, tab = 'files', path = '') =>
              navigate({ section: 'folders', ...(folderId ? { folderId, tab, path } : {}) })
            }
          />
        )}
        {location.section === 'settings' && <SettingsPanel onPasswordChanged={onLogout} />}
      </main>
    </div>
  );
}

function NavButton({
  id,
  label,
  icon,
  current,
  onSelect,
}: {
  id: Section;
  label: string;
  icon: string;
  current: Section;
  onSelect: (section: Section) => void;
}) {
  return (
    <button className={current === id ? 'active' : ''} onClick={() => onSelect(id)}>
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

function Overview({
  node,
  onNavigate,
}: {
  node: NodeInfo;
  onNavigate: (section: Section) => void;
}) {
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders });
  const pendingDevices = useQuery({
    queryKey: ['devices', 'pending'],
    queryFn: api.pendingDevices,
  });
  const pendingFolders = useQuery({
    queryKey: ['folders', 'pending'],
    queryFn: api.pendingFolders,
  });

  const paired = devices.data?.items ?? [];
  const shared = folders.data?.items ?? [];
  const needBytes = shared.reduce((total, folder) => total + folder.needBytes, 0);
  const needItems = shared.reduce((total, folder) => total + (folder.needItems ?? 0), 0);
  const needDeletes = shared.reduce((total, folder) => total + (folder.needDeletes ?? 0), 0);
  const divergences = shared.reduce(
    (total, folder) => total + (folder.receiveOnlyChangedItems ?? 0),
    0,
  );
  const errors = shared.filter((folder) => folder.error || folder.pathConflicts?.length);
  const offline = paired.filter((device) => !device.connected && !device.paused);
  const lastCompletedAt = shared
    .map((folder) => folder.lastCompletedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const pendingCount =
    (pendingDevices.data?.items.length ?? 0) + (pendingFolders.data?.items.length ?? 0);
  const detailStale =
    devices.isError || folders.isError || pendingDevices.isError || pendingFolders.isError;
  const lastDetailUpdate = Math.max(
    devices.dataUpdatedAt,
    folders.dataUpdatedAt,
    pendingDevices.dataUpdatedAt,
    pendingFolders.dataUpdatedAt,
  );

  return (
    <>
      {detailStale && (
        <Card className="stale-banner" role="alert">
          <strong>同步详情暂时无法更新，以下为最后一次成功数据</strong>
          {lastDetailUpdate > 0 && (
            <span>最后成功：{new Date(lastDetailUpdate).toLocaleString('zh-CN')}</span>
          )}
          <Button
            className="secondary-button"
            onClick={() => {
              void devices.refetch();
              void folders.refetch();
              void pendingDevices.refetch();
              void pendingFolders.refetch();
            }}
          >
            重新连接
          </Button>
        </Card>
      )}
      <div className="metric-grid">
        <Card className="metric-card">
          <span>已连接设备</span>
          <strong>{node.connectedPeers}</strong>
          <small>已配对 {paired.length} 台</small>
        </Card>
        <Card className="metric-card">
          <span>同步文件夹</span>
          <strong>{shared.length}</strong>
          <small>
            {lastCompletedAt
              ? `最近完成 ${new Date(lastCompletedAt).toLocaleString('zh-CN')}`
              : `${shared.filter((folder) => !folder.paused).length} 个正在工作`}
          </small>
        </Card>
        <Card className="metric-card">
          <span>等待同步</span>
          <strong>{formatBytes(needBytes)}</strong>
          <small>
            {needItems} 个项目 · {needDeletes} 个待删除
          </small>
        </Card>
      </div>

      {pendingCount > 0 && (
        <Card className="attention-card">
          <div className="attention-icon">!</div>
          <div>
            <strong>有新的同步请求</strong>
            <p>新设备或共享文件夹必须经过你确认，KiteSync 不会自动接受。</p>
          </div>
          <Button
            onClick={() =>
              onNavigate((pendingDevices.data?.items.length ?? 0) > 0 ? 'devices' : 'folders')
            }
          >
            去处理
          </Button>
        </Card>
      )}

      {(errors.length > 0 || offline.length > 0 || divergences > 0) && (
        <Card className="attention-card attention-list">
          <div className="attention-icon">!</div>
          <div>
            <strong>有需要处理的同步状态</strong>
            {errors.length > 0 && <p>{errors.length} 个文件夹存在错误或目录重叠</p>}
            {offline.length > 0 && <p>{offline.length} 台同步目标当前离线</p>}
            {divergences > 0 && <p>{divergences} 项仅接收目录本机变化等待处理</p>}
          </div>
          <Button onClick={() => onNavigate(errors.length || divergences ? 'folders' : 'devices')}>
            查看详情
          </Button>
        </Card>
      )}

      <div className="overview-grid overview-grid--single">
        <Card className="node-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">当前节点</p>
              <h2>{node.name}</h2>
            </div>
            <Badge tone={errors.length || node.engineStatus === 'unavailable' ? 'warn' : 'good'}>
              {node.engineStatus === 'unavailable'
                ? '同步引擎异常'
                : errors.length
                  ? '需要处理'
                  : '服务已连接'}
            </Badge>
          </div>
          <dl className="detail-list">
            <div>
              <dt>设备 ID</dt>
              <dd className="mono">{node.deviceId}</dd>
            </div>
            <div>
              <dt>短指纹</dt>
              <dd className="mono">{node.fingerprint}</dd>
            </div>
            <div>
              <dt>系统</dt>
              <dd>{platformName(node.platform)}</dd>
            </div>
            <div>
              <dt>KiteSync</dt>
              <dd>{node.version}</dd>
            </div>
            <div>
              <dt>Syncthing</dt>
              <dd>{node.syncthingVersion}</dd>
            </div>
            <div>
              <dt>监听地址</dt>
              <dd className="mono">
                {node.listenAddresses.length ? node.listenAddresses.join(' · ') : '尚未监听'}
              </dd>
            </div>
            <div>
              <dt>本地发现</dt>
              <dd>{node.localDiscoveryEnabled ? '已开启' : '不可用'}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card className="quick-actions">
        <button onClick={() => onNavigate('devices')}>
          <b>连接另一台设备</b>
          <span>查看局域网发现或输入设备 ID</span>
        </button>
        <button onClick={() => onNavigate('folders')}>
          <b>添加同步文件夹</b>
          <span>选择本机目录和同步目标</span>
        </button>
        <button onClick={() => onNavigate('settings')}>
          <b>调整访问设置</b>
          <span>配置 LAN 访问和 HTTPS 来源</span>
        </button>
      </Card>
    </>
  );
}

function platformName(platform: NodeInfo['platform']) {
  if (platform === 'windows') return 'Windows';
  if (platform === 'macos') return 'macOS';
  return 'Linux';
}
