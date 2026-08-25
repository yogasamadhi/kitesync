import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, formatBytes } from '@kitesync/ui';
import { api, type Session } from './api.js';

const stateNames: Record<string, string> = {
  pending_approval: '待批准',
  verifying_syncthing_identity: '验证连接',
  active: '正常',
  suspended: '已暂停',
  revoking: '吊销中',
  revoked: '已吊销',
  provisioning: '配置中',
  degraded: '异常',
  retained: '回收站',
  paused: '已暂停',
  syncing: '同步中',
};

export function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState('overview');
  const runtime = useQuery({ queryKey: ['runtime'], queryFn: api.runtime });
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: api.spaces });
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: api.users,
  });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
  const admin = session.user.role === 'admin';
  const hubs = useQuery({ queryKey: ['hubs'], queryFn: api.hubs, enabled: admin });
  const auditEvents = useQuery({
    queryKey: ['audit-events'],
    queryFn: api.auditEvents,
    enabled: admin,
  });
  const backupRuns = useQuery({
    queryKey: ['backup-runs'],
    queryFn: api.backupRuns,
    enabled: admin,
  });
  const updateReleases = useQuery({
    queryKey: ['update-releases'],
    queryFn: api.updateReleases,
    enabled: admin,
  });
  const refresh = () => void queryClient.invalidateQueries();
  const storage = useMemo(
    () => spaces.data?.items.reduce((sum, space) => sum + space.usedBytes, 0) ?? 0,
    [spaces.data],
  );

  return (
    <div className="app-shell">
      <aside>
        <div className="logo">
          <span className="brand-mark">K</span>
          <b>KiteSync</b>
        </div>
        <nav>
          {[
            ['overview', '总览'],
            ['spaces', '同步空间'],
            ['devices', '设备'],
            ...(session.user.role === 'admin' ? [['users', '用户']] : []),
            ['sessions', '登录会话'],
            ['operations', '运行状态'],
          ].map(([id, label]) => (
            <button
              key={id}
              className={section === id ? 'active' : ''}
              onClick={() => setSection(id!)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="account">
          <span>{session.user.displayName}</span>
          <small>{session.user.role === 'admin' ? '管理员' : '成员'}</small>
          <button onClick={() => void api.logout().finally(onLogout)}>退出</button>
        </div>
      </aside>
      <main className="content">
        <header>
          <div>
            <p className="eyebrow">KITESYNC CONTROL PLANE</p>
            <h1>
              {section === 'overview'
                ? '工作区总览'
                : section === 'spaces'
                  ? '同步空间'
                  : section === 'devices'
                    ? '设备'
                    : section === 'users'
                      ? '用户'
                      : section === 'sessions'
                        ? '登录会话'
                        : '运行状态'}
            </h1>
          </div>
          <Button onClick={refresh}>刷新</Button>
        </header>
        {section === 'overview' && (
          <Overview
            storage={storage}
            spaces={spaces.data?.items.length ?? 0}
            devices={devices.data?.items ?? []}
          />
        )}
        {section === 'spaces' && (
          <Spaces
            items={spaces.data?.items ?? []}
            users={users.data?.items ?? []}
            currentUserId={session.user.id}
            admin={session.user.role === 'admin'}
            onChanged={refresh}
          />
        )}
        {section === 'devices' && (
          <Devices
            items={devices.data?.items ?? []}
            admin={session.user.role === 'admin'}
            onChanged={refresh}
          />
        )}
        {section === 'users' && <Users items={users.data?.items ?? []} onChanged={refresh} />}
        {section === 'sessions' && (
          <Sessions
            items={sessions.data?.items ?? []}
            onCurrentRevoked={onLogout}
            onChanged={refresh}
          />
        )}
        {section === 'operations' && (
          <Operations
            runtime={runtime.data}
            admin={admin}
            hubs={hubs.data?.items ?? []}
            auditEvents={auditEvents.data?.items ?? []}
            backupRuns={backupRuns.data?.items ?? []}
            updateReleases={updateReleases.data?.items ?? []}
          />
        )}
      </main>
    </div>
  );
}

function Overview({
  storage,
  spaces,
  devices,
}: {
  storage: number;
  spaces: number;
  devices: Array<{ state: string }>;
}) {
  return (
    <>
      <div className="metric-grid">
        <Card>
          <span>同步空间</span>
          <strong>{spaces}</strong>
          <small>单 Hub 承载</small>
        </Card>
        <Card>
          <span>已用容量</span>
          <strong>{formatBytes(storage)}</strong>
          <small>包含服务器版本</small>
        </Card>
        <Card>
          <span>在线就绪设备</span>
          <strong>{devices.filter((d) => d.state === 'active').length}</strong>
          <small>共 {devices.length} 台设备</small>
        </Card>
      </div>
      <Card className="notice">
        <div className="pulse" />
        <div>
          <strong>服务器中心模式已启用</strong>
          <p>客户端只连接组织 Hub。公共发现、Relay、NAT 穿透与客户端 P2P 均已禁用。</p>
        </div>
      </Card>
    </>
  );
}

function Spaces({
  items,
  users,
  currentUserId,
  admin,
  onChanged,
}: {
  items: Array<any>;
  users: Array<any>;
  currentUserId: string;
  admin: boolean;
  onChanged: () => void;
}) {
  const mutation = useMutation({
    mutationFn: ({ label, quota }: { label: string; quota: number }) =>
      api.createSpace(label, quota),
    onSuccess: onChanged,
  });
  const remove = useMutation({ mutationFn: api.deleteSpace, onSuccess: onChanged });
  const restore = useMutation({ mutationFn: api.restoreSpace, onSuccess: onChanged });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({
      label: String(data.get('label')),
      quota: Number(data.get('quota')) * 1024 ** 3,
    });
    event.currentTarget.reset();
  }
  return (
    <>
      <Card>
        <form className="inline-form" onSubmit={submit}>
          <label>
            空间名称
            <input name="label" required placeholder="例如：设计资料" />
          </label>
          <label>
            配额（GiB）
            <input name="quota" type="number" min="1" defaultValue="100" required />
          </label>
          <Button>创建空间</Button>
        </form>
      </Card>
      <div className="table-card">
        {items.length === 0 ? (
          <EmptyState title="还没有同步空间" detail="创建后即可邀请成员并选择设备。" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>状态</th>
                <th>容量</th>
                <th>保留至</th>
                <th>共享</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((space) => (
                <tr key={space.id}>
                  <td>
                    <b>{space.label}</b>
                    <small>{space.syncthingFolderId}</small>
                  </td>
                  <td>
                    <Badge tone={space.state === 'active' ? 'good' : 'neutral'}>
                      {stateNames[space.state] ?? space.state}
                    </Badge>
                  </td>
                  <td>
                    {formatBytes(space.usedBytes)} / {formatBytes(space.quotaBytes)}
                    {admin && <QuotaEditor space={space} onChanged={onChanged} />}
                  </td>
                  <td>
                    {space.deleteAfter ? new Date(space.deleteAfter).toLocaleDateString() : '—'}
                  </td>
                  <td>
                    {(admin || space.ownerUserId === currentUserId) && (
                      <div className="space-actions">
                        <SpaceSharing space={space} users={users} onChanged={onChanged} />
                        <VersionHistory space={space} />
                      </div>
                    )}
                  </td>
                  <td>
                    {(admin || space.ownerUserId === currentUserId) &&
                      (space.state === 'retained' ? (
                        <Button onClick={() => restore.mutate(space)}>恢复空间</Button>
                      ) : (
                        <button className="danger-link" onClick={() => remove.mutate(space)}>
                          移入回收站
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function QuotaEditor({ space, onChanged }: { space: any; onChanged: () => void }) {
  const update = useMutation({
    mutationFn: (quotaGiB: number) => api.updateSpaceQuota(space, quotaGiB * 1024 ** 3),
    onSuccess: onChanged,
  });
  return (
    <details>
      <summary>调整</summary>
      <input
        aria-label="空间配额 GiB"
        type="number"
        min="1"
        defaultValue={Math.ceil(space.quotaBytes / 1024 ** 3)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') update.mutate(Number(event.currentTarget.value));
        }}
      />
    </details>
  );
}

function VersionHistory({ space }: { space: any }) {
  const [opened, setOpened] = useState(false);
  const versions = useQuery({
    queryKey: ['versions', space.id],
    queryFn: () => api.versions(space.id),
    enabled: opened,
  });
  const restore = useMutation({
    mutationFn: (version: { path: string; versionTime: string }) =>
      api.restoreVersion(space.id, version),
  });
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>历史版本</summary>
      {versions.isLoading && <small>读取中…</small>}
      {versions.data?.items.slice(0, 50).map((version) => (
        <div className="version-row" key={`${version.path}:${version.versionTime}`}>
          <span title={version.path}>{version.path}</span>
          <small>{new Date(version.modifiedAt).toLocaleString()}</small>
          <button onClick={() => restore.mutate(version)}>恢复</button>
        </div>
      ))}
      {versions.data?.items.length === 0 && <small>暂无可恢复版本</small>}
    </details>
  );
}

function SpaceSharing({
  space,
  users,
  onChanged,
}: {
  space: any;
  users: Array<any>;
  onChanged: () => void;
}) {
  const shares = useQuery({
    queryKey: ['space-shares', space.id],
    queryFn: () => api.spaceShares(space.id),
  });
  const share = useMutation({
    mutationFn: (userId: string) => api.shareSpace(space, userId),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: (shareId: string) => api.removeSpaceShare(space, shareId),
    onSuccess: onChanged,
  });
  const active = shares.data?.items.filter((item) => item.state !== 'revoked') ?? [];
  const available = users.filter(
    (user) => user.id !== space.ownerUserId && !active.some((item) => item.userId === user.id),
  );
  return (
    <details>
      <summary>{active.length} 位成员</summary>
      {active.map((item) => (
        <div className="share-row" key={item.id}>
          <span>{users.find((user) => user.id === item.userId)?.displayName ?? item.userId}</span>
          <button className="danger-link" onClick={() => remove.mutate(item.id)}>
            移除
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <select
          defaultValue=""
          onChange={(event) => event.target.value && share.mutate(event.target.value)}
        >
          <option value="" disabled>
            邀请用户…
          </option>
          {available.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        </select>
      )}
    </details>
  );
}

function Devices({
  items,
  admin,
  onChanged,
}: {
  items: Array<any>;
  admin: boolean;
  onChanged: () => void;
}) {
  const approve = useMutation({ mutationFn: api.approveDevice, onSuccess: onChanged });
  const suspend = useMutation({ mutationFn: api.suspendDevice, onSuccess: onChanged });
  const resume = useMutation({ mutationFn: api.resumeDevice, onSuccess: onChanged });
  const revoke = useMutation({ mutationFn: api.revokeDevice, onSuccess: onChanged });
  if (!items.length)
    return (
      <EmptyState title="没有已注册设备" detail="在桌面客户端登录后，设备会出现在这里等待批准。" />
    );
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>设备</th>
            <th>平台</th>
            <th>状态</th>
            <th>上次在线</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((device) => (
            <tr key={device.id}>
              <td>
                <b>{device.displayName}</b>
                <small>{device.syncthingDeviceId.slice(0, 19)}…</small>
              </td>
              <td>{device.platform}</td>
              <td>
                <Badge
                  tone={
                    device.state === 'active'
                      ? 'good'
                      : device.state === 'pending_approval'
                        ? 'warn'
                        : 'neutral'
                  }
                >
                  {stateNames[device.state] ?? device.state}
                </Badge>
              </td>
              <td>{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '从未'}</td>
              <td>
                {admin && device.state === 'pending_approval' && (
                  <Button onClick={() => approve.mutate(device)}>批准</Button>
                )}
                {admin && device.state === 'active' && (
                  <button className="danger-link" onClick={() => suspend.mutate(device)}>
                    暂停
                  </button>
                )}
                {admin && device.state === 'suspended' && (
                  <Button onClick={() => resume.mutate(device)}>恢复</Button>
                )}
                {admin && !['revoked', 'revoking'].includes(device.state) && (
                  <button className="danger-link" onClick={() => revoke.mutate(device)}>
                    吊销
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Users({ items, onChanged }: { items: Array<any>; onChanged: () => void }) {
  const [issuedSecret, setIssuedSecret] = useState<{
    title: string;
    token: string;
    expiresAt: string;
  }>();
  const create = useMutation({
    mutationFn: api.createInvitation,
    onSuccess: (invitation) => {
      setIssuedSecret({ title: '邀请令牌', ...invitation });
      onChanged();
    },
  });
  const reset = useMutation({
    mutationFn: api.issuePasswordReset,
    onSuccess: (result) => setIssuedSecret({ title: '密码重置令牌', ...result }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      username: String(data.get('username')),
      displayName: String(data.get('displayName')),
      role: String(data.get('role')) as 'admin' | 'member',
    });
    event.currentTarget.reset();
  }
  return (
    <>
      <Card>
        <form className="inline-form" onSubmit={submit}>
          <label>
            显示名称
            <input name="displayName" required />
          </label>
          <label>
            用户名
            <input name="username" required minLength={3} />
          </label>
          <label>
            角色
            <select name="role" defaultValue="member">
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <Button>生成邀请</Button>
        </form>
        {issuedSecret && (
          <div className="token-result">
            <b>{issuedSecret.title}（仅通过可信渠道发送）</b>
            <code>{issuedSecret.token}</code>
            <small>有效期至 {new Date(issuedSecret.expiresAt).toLocaleString()}</small>
          </div>
        )}
      </Card>
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>姓名</th>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id}>
                <td>
                  <b>{user.displayName}</b>
                </td>
                <td>{user.username}</td>
                <td>{user.role === 'admin' ? '管理员' : '成员'}</td>
                <td>
                  <Badge tone={user.active ? 'good' : 'neutral'}>
                    {user.active ? '启用' : '停用'}
                  </Badge>
                </td>
                <td>
                  <button className="danger-link" onClick={() => reset.mutate(user.id)}>
                    重置密码
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Sessions({
  items,
  onChanged,
  onCurrentRevoked,
}: {
  items: Array<any>;
  onChanged: () => void;
  onCurrentRevoked: () => void;
}) {
  const revoke = useMutation({
    mutationFn: api.revokeSession,
    onSuccess: (_result, id) => {
      if (items.find((session) => session.id === id)?.current) onCurrentRevoked();
      else onChanged();
    },
  });
  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th>会话</th>
            <th>最后使用</th>
            <th>到期时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((session) => (
            <tr key={session.id}>
              <td>
                <b>{session.current ? '当前会话' : session.id.slice(0, 8)}</b>
              </td>
              <td>{new Date(session.lastUsedAt).toLocaleString()}</td>
              <td>{new Date(session.expiresAt).toLocaleString()}</td>
              <td>
                <button className="danger-link" onClick={() => revoke.mutate(session.id)}>
                  撤销
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Operations({
  runtime,
  admin,
  hubs,
  auditEvents,
  backupRuns,
  updateReleases,
}: {
  runtime?: any;
  admin: boolean;
  hubs: Array<any>;
  auditEvents: Array<any>;
  backupRuns: Array<any>;
  updateReleases: Array<any>;
}) {
  return (
    <>
      <div className="metric-grid">
        <Card>
          <span>API 版本</span>
          <strong>{runtime?.apiVersion ?? '—'}</strong>
          <small>KiteSync {runtime?.version ?? ''}</small>
        </Card>
        <Card>
          <span>运行实例</span>
          <strong className="mono">{runtime?.runtimeId?.slice(0, 8) ?? '—'}</strong>
          <small>generation {runtime?.generation?.slice(0, 8) ?? '—'}</small>
        </Card>
        <Card>
          <span>能力协商</span>
          <strong>{runtime?.capabilities?.length ?? 0}</strong>
          <small>{runtime?.capabilities?.join(' · ')}</small>
        </Card>
      </div>
      {admin && (
        <div className="operations-grid">
          <OperationTable
            title="Hub"
            empty="尚无 Hub 记录"
            rows={hubs.map((hub) => ({
              primary: hub.name ?? hub.id,
              secondary: `${hub.endpoint ?? '未设置数据地址'} · ${formatBytes(hub.usedBytes ?? 0)} / ${formatBytes(hub.capacityBytes ?? 0)}`,
              status: hub.state ?? 'unknown',
            }))}
          />
          <OperationTable
            title="备份"
            empty="尚无备份运行记录"
            rows={backupRuns.map((run) => ({
              primary: `${run.type === 'manual' ? '手动' : '计划'}备份`,
              secondary: new Date(run.startedAt).toLocaleString(),
              status: run.state,
            }))}
          />
          <OperationTable
            title="客户端发布"
            empty="尚未发布 stable 版本"
            rows={updateReleases.map((release) => ({
              primary: release.version,
              secondary: `最低客户端 ${release.minimumClientVersion ?? '未限制'}`,
              status: release.channel,
            }))}
          />
          <OperationTable
            title="最近审计"
            empty="暂无审计事件"
            rows={auditEvents.map((event) => ({
              primary: event.action,
              secondary: new Date(event.occurredAt).toLocaleString(),
              status: event.targetType,
            }))}
          />
        </div>
      )}
    </>
  );
}

function OperationTable({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ primary: string; secondary: string; status: string }>;
}) {
  return (
    <Card>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <small>{empty}</small>
      ) : (
        rows.slice(0, 10).map((row, index) => (
          <div className="operation-row" key={`${row.primary}:${index}`}>
            <div>
              <b>{row.primary}</b>
              <small>{row.secondary}</small>
            </div>
            <Badge
              tone={['active', 'succeeded', 'stable'].includes(row.status) ? 'good' : 'neutral'}
            >
              {stateNames[row.status] ?? row.status}
            </Badge>
          </div>
        ))
      )}
    </Card>
  );
}
