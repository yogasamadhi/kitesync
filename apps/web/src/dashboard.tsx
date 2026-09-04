import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, formatBytes } from '@kitesync/ui';
import type { NodeInfo } from '@kitesync/contracts';
import { api } from './api.js';
import { DevicesPanel } from './devices-panel.js';
import { FoldersPanel } from './folders-panel.js';
import { SettingsPanel } from './settings-panel.js';

type Section = 'overview' | 'devices' | 'folders' | 'settings';

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
  const [section, setSection] = useState<Section>('overview');
  const queryClient = useQueryClient();
  const node = useQuery({ queryKey: ['node'], queryFn: api.node, initialData: initialNode });

  const refresh = () => void queryClient.invalidateQueries();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="logo">
          <span className="brand-mark">K</span>
          <div>
            <b>KiteSync</b>
            <small>本机节点</small>
          </div>
        </div>
        <nav aria-label="主导航">
          <NavButton id="overview" label="总览" icon="⌂" current={section} onSelect={setSection} />
          <NavButton id="devices" label="设备" icon="◇" current={section} onSelect={setSection} />
          <NavButton id="folders" label="文件夹" icon="▱" current={section} onSelect={setSection} />
          <NavButton id="settings" label="设置" icon="⚙" current={section} onSelect={setSection} />
        </nav>
        <div className="node-summary">
          <span className="status-dot" />
          <div>
            <strong>{node.data.name}</strong>
            <small>节点正在运行</small>
          </div>
        </div>
        <button className="logout-button" onClick={() => void api.logout().finally(onLogout)}>
          锁定管理界面
        </button>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">{sectionCopy[section].detail}</p>
            <h1>{sectionCopy[section].title}</h1>
          </div>
          <Button className="secondary-button" onClick={refresh}>
            刷新状态
          </Button>
        </header>

        {section === 'overview' && (
          <Overview node={node.data} onNavigate={(destination) => setSection(destination)} />
        )}
        {section === 'devices' && <DevicesPanel node={node.data} />}
        {section === 'folders' && <FoldersPanel canRevealFiles={node.data.canRevealFiles} />}
        {section === 'settings' && <SettingsPanel />}
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
  const pendingCount =
    (pendingDevices.data?.items.length ?? 0) + (pendingFolders.data?.items.length ?? 0);

  return (
    <>
      <div className="metric-grid">
        <Card className="metric-card">
          <span>已连接设备</span>
          <strong>{node.connectedPeers}</strong>
          <small>已配对 {paired.length} 台</small>
        </Card>
        <Card className="metric-card">
          <span>同步文件夹</span>
          <strong>{shared.length}</strong>
          <small>{shared.filter((folder) => !folder.paused).length} 个正在工作</small>
        </Card>
        <Card className="metric-card">
          <span>等待同步</span>
          <strong>{formatBytes(needBytes)}</strong>
          <small>{pendingCount ? `${pendingCount} 项请求待处理` : '没有待处理请求'}</small>
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

      <div className="overview-grid">
        <Card className="node-card">
          <div className="card-heading">
            <div>
              <p className="eyebrow">当前节点</p>
              <h2>{node.name}</h2>
            </div>
            <Badge tone="good">运行中</Badge>
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

        <Card className="principle-card">
          <p className="eyebrow">本地优先</p>
          <h2>没有必需的中心服务器</h2>
          <p>
            设备在局域网内直接同步。Linux 电脑可以像任何其他节点一样常驻在线，但并不拥有其他设备。
          </p>
          <div className="flow-line" aria-label="设备直接连接示意">
            <span>这台电脑</span>
            <i />
            <span>已配对设备</span>
          </div>
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
