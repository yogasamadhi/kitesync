import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, formatBytes } from '@kitesync/ui';
import type {
  Device,
  Folder,
  FolderFile,
  FolderType,
  PendingFolder,
  VersionEntry,
} from '@kitesync/contracts';
import { api } from './api.js';
import { DirectoryPicker, type SelectedDirectory } from './directory-picker.js';
import { confirmDiscardChanges, useUnsavedChanges } from './unsaved-changes.js';

const folderTypeNames: Record<FolderType, string> = {
  sendreceive: '双向同步',
  sendonly: '仅发送',
  receiveonly: '仅接收',
};

const folderStateNames: Record<Folder['state'], string> = {
  idle: '已同步',
  scanning: '正在扫描',
  syncing: '正在同步',
  paused: '已暂停',
  error: '需要处理',
};

export function FoldersPanel({
  canRevealFiles,
  canPickDirectories,
  nodeName,
  selectedFolderId,
  selectedTab,
  selectedPath,
  onNavigate,
}: {
  canRevealFiles: boolean;
  canPickDirectories: boolean;
  nodeName: string;
  selectedFolderId?: string;
  selectedTab: 'files' | 'versions' | 'settings';
  selectedPath: string;
  onNavigate: (folderId?: string, tab?: 'files' | 'versions' | 'settings', path?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'status'>('status');
  const [message, setMessage] = useState('');
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders });
  const pending = useQuery({ queryKey: ['folders', 'pending'], queryFn: api.pendingFolders });
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['folders'] });
  const queryError = folders.error ?? pending.error ?? devices.error;
  const allFolders = folders.data?.items ?? [];
  const filteredFolders = allFolders
    .filter((folder) =>
      `${folder.label}\0${folder.pathLabel}`
        .toLocaleLowerCase('zh-CN')
        .includes(search.toLocaleLowerCase('zh-CN')),
    )
    .sort((left, right) =>
      sort === 'name'
        ? left.label.localeCompare(right.label, 'zh-CN')
        : Number(Boolean(right.error)) - Number(Boolean(left.error)) ||
          Number(right.needBytes > 0) - Number(left.needBytes > 0) ||
          left.label.localeCompare(right.label, 'zh-CN'),
    );
  const selectedFolder = allFolders.find((folder) => folder.id === selectedFolderId);

  return (
    <div className="stack">
      {folders.isError && folders.data && (
        <div className="stale-banner" role="alert">
          <strong>文件夹状态暂时无法更新，以下为旧数据</strong>
          <span>最后成功：{new Date(folders.dataUpdatedAt).toLocaleString('zh-CN')}</span>
          <button className="ghost-button" onClick={() => void folders.refetch()}>
            重新连接
          </button>
        </div>
      )}
      {(pending.data?.items.length ?? 0) > 0 && (
        <section>
          <div className="section-heading">
            <h2>别人共享给你的文件夹</h2>
            <span>{pending.data?.items.length}</span>
          </div>
          <div className="card-list">
            {pending.data?.items.map((offer) => (
              <PendingFolderCard
                key={`${offer.deviceId}:${offer.folderId}`}
                offer={offer}
                canPickDirectories={canPickDirectories}
                nodeName={nodeName}
                {...(() => {
                  const existingFolder = allFolders.find((folder) => folder.id === offer.folderId);
                  return existingFolder ? { existingFolder } : {};
                })()}
                onChanged={() => {
                  setMessage('文件夹邀请已处理');
                  refresh();
                }}
              />
            ))}
          </div>
        </section>
      )}

      {(allFolders.length === 0 || showCreate) && (
        <NewFolderCard
          devices={devices.data?.items ?? []}
          canPickDirectories={canPickDirectories}
          nodeName={nodeName}
          onChanged={() => {
            setShowCreate(false);
            setMessage('同步文件夹已创建');
            refresh();
          }}
        />
      )}

      <section>
        <div className="section-heading folder-list-heading">
          <h2>我的同步文件夹</h2>
          <span>{folders.data?.items.length ?? 0}</span>
          {allFolders.length > 0 && (
            <Button
              onClick={() => {
                if (showCreate && !confirmDiscardChanges()) return;
                setShowCreate((value) => !value);
              }}
            >
              {showCreate ? '收起' : '添加文件夹'}
            </Button>
          )}
        </div>
        {allFolders.length > 0 && (
          <div className="list-toolbar">
            <input
              aria-label="搜索文件夹"
              placeholder="搜索名称或目录"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
            <select
              aria-label="文件夹排序"
              value={sort}
              onChange={(event) => setSort(event.currentTarget.value as 'name' | 'status')}
            >
              <option value="status">异常优先</option>
              <option value="name">按名称</option>
            </select>
          </div>
        )}
        <div className="folder-list">
          {folders.isLoading ? (
            <Card className="quiet-card">正在读取同步文件夹…</Card>
          ) : filteredFolders.length ? (
            filteredFolders.map((folder) => (
              <button
                key={folder.id}
                className={`folder-list-row ${selectedFolderId === folder.id ? 'active' : ''}`}
                onClick={() => onNavigate(folder.id)}
              >
                <span className="folder-icon">▱</span>
                <span>
                  <b>{folder.label}</b>
                  <small>
                    {folder.pathLabel} · {folderTypeNames[folder.type]}
                  </small>
                </span>
                <Badge
                  tone={
                    folder.state === 'error' || folder.pathConflicts?.length
                      ? 'warn'
                      : folder.paused
                        ? 'neutral'
                        : 'good'
                  }
                >
                  {folderStatusName(folder)}
                </Badge>
                <em>{folderProgressText(folder, nodeName)}</em>
              </button>
            ))
          ) : (
            <Card>
              <EmptyState
                title="还没有同步文件夹"
                detail={`从 ${nodeName} 选择一个目录，然后勾选要同步到的设备。`}
              />
            </Card>
          )}
        </div>
      </section>
      {selectedFolder && (
        <FolderCard
          folder={selectedFolder}
          devices={devices.data?.items ?? []}
          canRevealFiles={canRevealFiles}
          canPickDirectories={canPickDirectories}
          nodeName={nodeName}
          tab={selectedTab}
          path={selectedPath}
          onNavigate={(tab, path = '') => onNavigate(selectedFolder.id, tab, path)}
          onChanged={refresh}
        />
      )}
      {queryError && <p className="form-error">{errorMessage(queryError)}</p>}
      {message && (
        <p className="success-message" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}

function NewFolderCard({
  devices,
  canPickDirectories,
  nodeName,
  onChanged,
}: {
  devices: Device[];
  canPickDirectories: boolean;
  nodeName: string;
  onChanged: () => void;
}) {
  const [directory, setDirectory] = useState<SelectedDirectory>();
  const [label, setLabel] = useState('');
  const [labelCustomized, setLabelCustomized] = useState(false);
  const create = useMutation({
    mutationFn: api.createFolder,
    onSuccess: () => {
      setDirectory(undefined);
      setLabel('');
      setLabelCustomized(false);
      onChanged();
    },
  });
  useUnsavedChanges(Boolean(directory || label));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!directory) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    create.mutate(
      {
        label: String(form.get('label') ?? '').trim(),
        directoryId: directory.id,
        type: String(form.get('type')) as FolderType,
        deviceIds: form.getAll('deviceId').map(String),
      },
      { onSuccess: () => formElement.reset() },
    );
  }

  return (
    <Card className="create-folder-card">
      <div className="card-heading compact-heading">
        <div>
          <p className="eyebrow">新建共享</p>
          <h2>添加同步文件夹</h2>
          <p>路径只在 {nodeName} 保存，不会发送给其他设备。</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid two-columns">
          <label>
            显示名称
            <input
              name="label"
              required
              maxLength={128}
              placeholder="选择目录后自动填写"
              value={label}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setLabel(value);
                setLabelCustomized(value !== (directory?.label ?? ''));
              }}
            />
          </label>
          <label>
            同步方向
            <select name="type" defaultValue="sendreceive">
              <option value="sendreceive">双向同步</option>
              <option value="sendonly">仅从 {nodeName} 发送</option>
              <option value="receiveonly">仅在 {nodeName} 接收</option>
            </select>
          </label>
        </div>
        <DirectoryPicker
          selected={directory}
          native={canPickDirectories}
          nodeName={nodeName}
          onSelect={(selection) => {
            setDirectory(selection);
            if (!labelCustomized) setLabel(selection.label);
          }}
        />
        <fieldset className="device-choices">
          <legend>同步到设备</legend>
          {devices.length ? (
            devices.map((device) => (
              <label key={device.id}>
                <input type="checkbox" name="deviceId" value={device.id} />
                <span>
                  <b>{device.name}</b>
                  <small>{device.connected ? '在线' : '离线时自动等待'}</small>
                </span>
              </label>
            ))
          ) : (
            <p>尚未配对设备。可以先只在 {nodeName} 创建，稍后再添加设备。</p>
          )}
        </fieldset>
        {create.error && <p className="form-error">{errorMessage(create.error)}</p>}
        <div className="form-actions">
          <Button disabled={!directory || create.isPending}>
            {create.isPending ? '正在创建…' : '创建文件夹'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PendingFolderCard({
  offer,
  canPickDirectories,
  existingFolder,
  nodeName,
  onChanged,
}: {
  offer: PendingFolder;
  canPickDirectories: boolean;
  existingFolder?: Folder;
  nodeName: string;
  onChanged: () => void;
}) {
  const [directory, setDirectory] = useState<SelectedDirectory>();
  const [type, setType] = useState<FolderType>('sendreceive');
  useUnsavedChanges(Boolean(directory || type !== 'sendreceive'));
  const accept = useMutation({
    mutationFn: () =>
      api.acceptPendingFolder(
        offer.deviceId,
        offer.folderId,
        existingFolder ? { useExisting: true } : { directoryId: directory!.id, type },
      ),
    onSuccess: onChanged,
  });
  const reject = useMutation({
    mutationFn: () => api.rejectPendingFolder(offer.deviceId, offer.folderId),
    onSuccess: onChanged,
  });
  return (
    <Card className="folder-offer-card">
      <div className="request-mark">⇄</div>
      <div className="offer-copy">
        <h3>{offer.label}</h3>
        <p>
          <b>{offer.deviceName}</b> 想与你同步此文件夹
        </p>
        <small>来源短指纹：{deviceFingerprint(offer.deviceId)}</small>
        <code>{offer.deviceId}</code>
        <small>{formatDate(offer.offeredAt)}</small>
      </div>
      <details>
        <summary>{existingFolder ? '确认共享现有文件夹' : '选择保存位置并接受'}</summary>
        {existingFolder ? (
          <p className="panel-note">
            将“{existingFolder.label}”共享给此设备；{nodeName} 的目录、同步方向和版本设置保持不变。
          </p>
        ) : (
          <DirectoryPicker
            selected={directory}
            native={canPickDirectories}
            nodeName={nodeName}
            onSelect={setDirectory}
          />
        )}
        {!existingFolder && (
          <label>
            {nodeName} 的同步方向
            <select value={type} onChange={(event) => setType(event.target.value as FolderType)}>
              <option value="sendreceive">双向同步</option>
              <option value="sendonly">仅从 {nodeName} 发送</option>
              <option value="receiveonly">仅在 {nodeName} 接收</option>
            </select>
          </label>
        )}
        <div className="row-actions">
          <button
            className="ghost-button"
            disabled={accept.isPending || reject.isPending}
            onClick={() => reject.mutate()}
          >
            拒绝
          </button>
          <Button
            disabled={(!existingFolder && !directory) || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {existingFolder ? '共享现有文件夹' : '接受共享'}
          </Button>
        </div>
        {(accept.error || reject.error) && (
          <p className="form-error">{errorMessage(accept.error ?? reject.error)}</p>
        )}
      </details>
    </Card>
  );
}

function FolderCard({
  folder,
  devices,
  canRevealFiles,
  canPickDirectories,
  nodeName,
  tab,
  path,
  onNavigate,
  onChanged,
}: {
  folder: Folder;
  devices: Device[];
  canRevealFiles: boolean;
  canPickDirectories: boolean;
  nodeName: string;
  tab: 'files' | 'versions' | 'settings';
  path: string;
  onNavigate: (tab: 'files' | 'versions' | 'settings', path?: string) => void;
  onChanged: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const tabPrefix = `folder-${folder.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const [actionMessage, setActionMessage] = useState('');
  useEffect(() => heading.current?.focus(), [folder.id]);
  const pause = useMutation({
    mutationFn: () => (folder.paused ? api.resumeFolder(folder.id) : api.pauseFolder(folder.id)),
    onSuccess: () => {
      setActionMessage(folder.paused ? '同步已继续' : '文件夹已暂停');
      onChanged();
    },
  });
  const scan = useMutation({
    mutationFn: () => api.scanFolder(folder.id),
    onSuccess: () => {
      setActionMessage('扫描已开始');
      onChanged();
    },
  });
  const repairMarker = useMutation({
    mutationFn: () => api.repairFolderMarker(folder.id),
    onSuccess: () => {
      setActionMessage('同步安全标记已恢复，正在扫描目录');
      onChanged();
    },
  });
  const revealRoot = useMutation({
    mutationFn: () => api.revealFolderFile(folder.id, { path: '' }),
  });
  const remove = useMutation({
    mutationFn: () => api.removeFolder(folder.id),
    onSuccess: onChanged,
  });

  return (
    <Card className="folder-card">
      <div className="folder-summary">
        <div className="folder-icon">▱</div>
        <div className="folder-name">
          <div className="row-title">
            <h2 ref={heading} tabIndex={-1}>
              {folder.label}
            </h2>
            <Badge tone={folder.state === 'error' ? 'warn' : folder.paused ? 'neutral' : 'good'}>
              {folderStatusName(folder)}
            </Badge>
          </div>
          <p>{folder.pathLabel}</p>
          <small>
            {folderTypeNames[folder.type]} · {folder.deviceIds.length} 台设备 ·{' '}
            {formatBytes(folder.localBytes)}
          </small>
        </div>
        <div className="folder-progress">
          <span>{folderProgressText(folder, nodeName)}</span>
          <div>
            <i
              style={{
                width: `${syncProgress(folder.localBytes, folder.needBytes)}%`,
              }}
            />
          </div>
        </div>
      </div>

      {folder.peerProgress?.length ? (
        <details className="peer-progress-list">
          <summary>共享设备进度（{folder.peerProgress.length}）</summary>
          {folder.peerProgress.map((progress) => {
            const device = devices.find((item) => item.id === progress.deviceId);
            return (
              <div key={progress.deviceId}>
                <span>
                  <b>{device?.name ?? progress.deviceId.slice(0, 7)}</b>
                  <small>
                    {device?.connected === false
                      ? '设备离线'
                      : progress.remoteState === 'paused'
                        ? '对方已暂停此文件夹'
                        : progress.remoteState === 'notSharing'
                          ? '等待对方确认共享'
                          : progress.remoteState === 'unknown'
                            ? '远端状态未知'
                            : '对方已接受共享'}
                  </small>
                </span>
                <span>
                  {progress.completion.toFixed(1)}% · 待处理 {progress.needItems} 项 · 待删除{' '}
                  {progress.needDeletes} 项
                </span>
              </div>
            );
          })}
        </details>
      ) : null}

      {folder.error && (
        <section className="folder-error" role="alert">
          <div className="folder-error-copy">
            <strong>{folderProblemTitle(folder)}</strong>
            <p>{folder.error}</p>
            {folder.errorCode === 'marker_missing' && !canRevealFiles && (
              <small>请在节点本机打开 KiteSync，检查目录后再执行恢复。</small>
            )}
          </div>
          <div className="folder-error-actions">
            {canRevealFiles && folder.errorCode !== 'path_missing' && (
              <button disabled={revealRoot.isPending} onClick={() => revealRoot.mutate()}>
                打开同步目录
              </button>
            )}
            {folder.errorCode === 'marker_missing' && canRevealFiles ? (
              <Button
                disabled={repairMarker.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `请确认“${folder.pathLabel}”仍是原来的同步目录，并且其中的文件完整。若外接磁盘或网络目录尚未连接，请取消并先恢复连接。\n\n确认恢复同步安全标记吗？`,
                    )
                  ) {
                    repairMarker.mutate();
                  }
                }}
              >
                {repairMarker.isPending ? '正在恢复…' : '确认目录无误并恢复'}
              </Button>
            ) : folder.errorCode === 'status_unavailable' ? (
              <button onClick={onChanged}>刷新状态</button>
            ) : (
              <button disabled={scan.isPending} onClick={() => scan.mutate()}>
                {scan.isPending ? '正在扫描…' : '重新扫描'}
              </button>
            )}
            {['path_missing', 'access_denied', 'unknown'].includes(folder.errorCode ?? '') && (
              <button onClick={() => onNavigate('settings')}>打开文件夹设置</button>
            )}
          </div>
        </section>
      )}

      <div
        className="folder-tabs"
        role="tablist"
        aria-label={`${folder.label} 详情`}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          event.preventDefault();
          tabs[next]?.focus();
          tabs[next]?.click();
        }}
      >
        <button
          id={`${tabPrefix}-files-tab`}
          role="tab"
          aria-controls={`${tabPrefix}-files-panel`}
          aria-selected={tab === 'files'}
          tabIndex={tab === 'files' ? 0 : -1}
          className={tab === 'files' ? 'active' : ''}
          onClick={() => onNavigate('files')}
        >
          文件
        </button>
        <button
          id={`${tabPrefix}-versions-tab`}
          role="tab"
          aria-controls={`${tabPrefix}-versions-panel`}
          aria-selected={tab === 'versions'}
          tabIndex={tab === 'versions' ? 0 : -1}
          className={tab === 'versions' ? 'active' : ''}
          onClick={() => onNavigate('versions')}
        >
          历史版本
        </button>
        <button
          id={`${tabPrefix}-settings-tab`}
          role="tab"
          aria-label="文件夹设置"
          aria-controls={`${tabPrefix}-settings-panel`}
          aria-selected={tab === 'settings'}
          tabIndex={tab === 'settings' ? 0 : -1}
          className={tab === 'settings' ? 'active' : ''}
          onClick={() => onNavigate('settings')}
        >
          设置
        </button>
        <span />
        <details className="folder-menu">
          <summary>操作</summary>
          <div>
            <button disabled={scan.isPending} onClick={() => scan.mutate()}>
              立即扫描
            </button>
            <button disabled={pause.isPending} onClick={() => pause.mutate()}>
              {folder.paused ? '继续同步' : '暂停'}
            </button>
          </div>
        </details>
      </div>

      {tab === 'files' && (
        <div
          id={`${tabPrefix}-files-panel`}
          role="tabpanel"
          aria-labelledby={`${tabPrefix}-files-tab`}
        >
          <ReadonlyFileBrowser
            folder={folder}
            canRevealFiles={canRevealFiles}
            nodeName={nodeName}
            path={path}
            onPathChange={(next) => onNavigate('files', next)}
          />
        </div>
      )}
      {tab === 'versions' && (
        <div
          id={`${tabPrefix}-versions-panel`}
          role="tabpanel"
          aria-labelledby={`${tabPrefix}-versions-tab`}
        >
          <Versions folder={folder} onChanged={onChanged} />
        </div>
      )}
      {tab === 'settings' && (
        <div
          id={`${tabPrefix}-settings-panel`}
          role="tabpanel"
          aria-labelledby={`${tabPrefix}-settings-tab`}
        >
          <FolderSettings
            folder={folder}
            devices={devices}
            canPickDirectories={canPickDirectories}
            nodeName={nodeName}
            onChanged={onChanged}
            onRemove={() => {
              if (window.confirm(`移除“${folder.label}”？本机文件不会被删除。`)) remove.mutate();
            }}
          />
        </div>
      )}
      {(pause.error || scan.error || repairMarker.error || revealRoot.error || remove.error) && (
        <p className="form-error">
          {errorMessage(
            pause.error ?? scan.error ?? repairMarker.error ?? revealRoot.error ?? remove.error,
          )}
        </p>
      )}
      {actionMessage && (
        <p className="success-message" role="status" aria-live="polite">
          {actionMessage}
        </p>
      )}
    </Card>
  );
}

function ReadonlyFileBrowser({
  folder,
  canRevealFiles,
  nodeName,
  path,
  onPathChange,
}: {
  folder: Folder;
  canRevealFiles: boolean;
  nodeName: string;
  path: string;
  onPathChange: (path: string) => void;
}) {
  const [showConflicts, setShowConflicts] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [conflictCursor, setConflictCursor] = useState<string>();
  const [conflictCursorHistory, setConflictCursorHistory] = useState<string[]>([]);
  const files = useQuery({
    queryKey: ['folder-files', folder.id, path, cursor],
    queryFn: () => api.folderFiles(folder.id, path, { ...(cursor ? { cursor } : {}), limit: 100 }),
    enabled: !showConflicts,
  });
  const conflicts = useQuery({
    queryKey: ['folder-conflicts', folder.id, conflictCursor],
    queryFn: () =>
      api.folderConflicts(folder.id, {
        ...(conflictCursor ? { cursor: conflictCursor } : {}),
      }),
    enabled: showConflicts,
  });
  const reveal = useMutation({
    mutationFn: (itemPath: string) => api.revealFolderFile(folder.id, { path: itemPath }),
  });

  function navigate(nextPath: string) {
    onPathChange(nextPath);
    setCursor(undefined);
    setCursorHistory([]);
  }

  const segments = path ? path.split('/').filter(Boolean) : [];

  return (
    <div className="file-browser">
      <div className="browser-toolbar">
        <div className="breadcrumbs">
          <button onClick={() => navigate('')}>{folder.label}</button>
          {segments.map((segment, index) => (
            <span key={`${segment}:${index}`}>
              <i>/</i>
              <button onClick={() => navigate(segments.slice(0, index + 1).join('/'))}>
                {segment}
              </button>
            </span>
          ))}
        </div>
        <div className="row-actions">
          <Badge>只读浏览</Badge>
          <button
            className="ghost-button"
            onClick={() => {
              setShowConflicts((value) => !value);
              setConflictCursor(undefined);
              setConflictCursorHistory([]);
            }}
          >
            {showConflicts ? '返回文件' : '冲突副本'}
          </button>
        </div>
      </div>
      {showConflicts && (
        <div className="conflict-list">
          {conflicts.isLoading && <p className="muted-line">正在查找冲突副本…</p>}
          {conflicts.isError && <p className="form-error">{errorMessage(conflicts.error)}</p>}
          {conflicts.data?.items.map((item) => (
            <div className="version-row" key={item.conflictPath}>
              <span className="file-glyph">!</span>
              <div>
                <b>{item.conflictPath}</b>
                <small>
                  疑似原文件：{item.originalPath ?? '已不存在'} · {formatBytes(item.size)} ·{' '}
                  {formatDate(item.modifiedAt)}
                </small>
              </div>
              <div className="file-actions">
                {canRevealFiles && (
                  <button onClick={() => reveal.mutate(item.conflictPath)}>
                    在 {nodeName} 定位冲突副本
                  </button>
                )}
                <a href={api.folderDownloadUrl(folder.id, item.conflictPath)} download>
                  下载冲突副本
                </a>
                {item.originalPath && canRevealFiles && (
                  <button onClick={() => reveal.mutate(item.originalPath as string)}>
                    在 {nodeName} 定位原文件
                  </button>
                )}
                {item.originalPath && (
                  <a href={api.folderDownloadUrl(folder.id, item.originalPath)} download>
                    下载原文件
                  </a>
                )}
              </div>
            </div>
          ))}
          {conflicts.data && !conflicts.data.items.length && (
            <EmptyState title="没有冲突副本" detail="发现 Syncthing 冲突副本时会列在这里。" />
          )}
          {(conflictCursorHistory.length > 0 || conflicts.data?.nextCursor) && (
            <div className="pagination">
              <button
                disabled={!conflictCursorHistory.length}
                onClick={() => {
                  const history = [...conflictCursorHistory];
                  setConflictCursor(history.pop());
                  setConflictCursorHistory(history);
                }}
              >
                上一页
              </button>
              <button
                disabled={!conflicts.data?.nextCursor}
                onClick={() => {
                  if (!conflicts.data?.nextCursor) return;
                  setConflictCursorHistory((history) => [...history, conflictCursor ?? '']);
                  setConflictCursor(conflicts.data.nextCursor ?? undefined);
                }}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}
      {!showConflicts && (
        <>
          {files.isLoading && <p className="muted-line">正在读取文件列表…</p>}
          {files.isError && <p className="form-error">{errorMessage(files.error)}</p>}
          {files.data?.items.length ? (
            <div className="file-table" role="table" aria-label={`${folder.label} 文件`}>
              {files.data.items.map((item) => (
                <FileRow
                  key={`${item.type}:${item.path}`}
                  item={item}
                  folderId={folder.id}
                  canRevealFiles={canRevealFiles}
                  nodeName={nodeName}
                  revealing={reveal.isPending}
                  onOpen={() => navigate(item.path)}
                  onReveal={() => reveal.mutate(item.path)}
                />
              ))}
            </div>
          ) : files.data ? (
            <EmptyState title="此目录为空" detail="同步到这里的文件会显示在此处。" />
          ) : null}
          {(cursorHistory.length > 0 || files.data?.nextCursor) && (
            <div className="pagination">
              <button
                disabled={!cursorHistory.length}
                onClick={() => {
                  const history = [...cursorHistory];
                  setCursor(history.pop());
                  setCursorHistory(history);
                }}
              >
                上一页
              </button>
              <button
                disabled={!files.data?.nextCursor}
                onClick={() => {
                  if (!files.data?.nextCursor) return;
                  setCursorHistory((history) => [...history, cursor ?? '']);
                  setCursor(files.data.nextCursor ?? undefined);
                }}
              >
                下一页
              </button>
            </div>
          )}
          {reveal.error && <p className="form-error">{errorMessage(reveal.error)}</p>}
        </>
      )}
    </div>
  );
}

function FileRow({
  item,
  folderId,
  canRevealFiles,
  nodeName,
  revealing,
  onOpen,
  onReveal,
}: {
  item: FolderFile;
  folderId: string;
  canRevealFiles: boolean;
  nodeName: string;
  revealing: boolean;
  onOpen: () => void;
  onReveal: () => void;
}) {
  return (
    <div className="file-row" role="row">
      <span className="file-glyph">
        {item.type === 'directory' ? '▱' : item.type === 'symlink' ? '↗' : '▤'}
      </span>
      <div className="file-name">
        {item.type === 'directory' ? (
          <button onClick={onOpen}>{item.name}</button>
        ) : (
          <b>{item.name}</b>
        )}
        <small>{formatDate(item.modifiedAt)}</small>
      </div>
      <span className="file-size">{item.type === 'directory' ? '—' : formatBytes(item.size)}</span>
      <div className="file-actions">
        {canRevealFiles && item.type !== 'symlink' && (
          <button disabled={revealing} onClick={onReveal}>
            在 {nodeName} 定位
          </button>
        )}
        {item.type === 'symlink' && <span className="unavailable-label">链接不可访问</span>}
        {item.type === 'file' && (
          <a href={api.folderDownloadUrl(folderId, item.path)} download={item.name}>
            下载
          </a>
        )}
      </div>
    </div>
  );
}

function Versions({ folder, onChanged }: { folder: Folder; onChanged: () => void }) {
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [success, setSuccess] = useState('');
  const versions = useQuery({
    queryKey: ['folder-versions', folder.id, search, cursor],
    queryFn: () =>
      api.folderVersions(folder.id, { search, limit: 50, ...(cursor ? { cursor } : {}) }),
    enabled: !folder.paused && folder.versioningDays > 0,
  });
  const resume = useMutation({
    mutationFn: () => api.resumeFolder(folder.id),
    onSuccess: onChanged,
  });
  const restore = useMutation({
    mutationFn: (version: VersionEntry) =>
      api.restoreFolderVersion(folder.id, {
        path: version.path,
        versionTime: version.versionTime,
      }),
    onSuccess: () => {
      setSuccess('版本恢复已提交并由同步引擎确认完成');
      void versions.refetch();
    },
  });

  return (
    <div className="versions-panel">
      <p className="panel-note">
        {folder.paused
          ? '此文件夹已暂停。请先明确继续同步，再读取或恢复历史版本。'
          : folder.versioningDays === 0
            ? '此文件夹的历史版本已关闭。'
            : `历史版本保留 ${folder.versioningDays} 天。远端替换或删除本机文件时，旧内容会按 Syncthing 版本策略保留；并非所有本机修改都会生成版本。`}
      </p>
      {folder.paused && (
        <Button disabled={resume.isPending} onClick={() => resume.mutate()}>
          继续同步后查看
        </Button>
      )}
      {!folder.paused && folder.versioningDays > 0 && (
        <input
          aria-label="搜索历史版本"
          placeholder="按文件名搜索"
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setCursor(undefined);
            setCursorHistory([]);
          }}
        />
      )}
      {versions.isLoading && <p className="muted-line">正在读取历史版本…</p>}
      {versions.isError && (
        <p className="form-error">
          {errorMessage(versions.error)}{' '}
          <button onClick={() => void versions.refetch()}>重试</button>
        </p>
      )}
      {versions.data?.items.length ? (
        [...new Set(versions.data.items.map((version) => version.path))].map((path) => (
          <section className="version-group" key={path}>
            <h3>{path}</h3>
            {versions.data?.items
              .filter((version) => version.path === path)
              .map((version) => (
                <div className="version-row" key={`${version.path}:${version.versionTime}`}>
                  <span className="file-glyph">↶</span>
                  <div>
                    <small>
                      {formatDate(version.versionTime)} · {formatBytes(version.size)}
                    </small>
                  </div>
                  <Button
                    className="secondary-button"
                    disabled={restore.isPending}
                    onClick={() => {
                      if (window.confirm(`恢复“${version.path}”的这个版本吗？`))
                        restore.mutate(version);
                    }}
                  >
                    恢复此版本
                  </Button>
                </div>
              ))}
          </section>
        ))
      ) : versions.data ? (
        <EmptyState
          title="暂无历史版本"
          detail="远端替换或删除产生可保留的旧内容后，会在这里出现。"
        />
      ) : null}
      {(cursorHistory.length > 0 || versions.data?.nextCursor) && (
        <div className="pagination">
          <button
            disabled={!cursorHistory.length}
            onClick={() => {
              const history = [...cursorHistory];
              setCursor(history.pop());
              setCursorHistory(history);
            }}
          >
            上一页
          </button>
          <button
            disabled={!versions.data?.nextCursor}
            onClick={() => {
              if (!versions.data?.nextCursor) return;
              setCursorHistory((history) => [...history, cursor ?? '']);
              setCursor(versions.data.nextCursor ?? undefined);
            }}
          >
            下一页
          </button>
        </div>
      )}
      {success && (
        <p className="success-message" role="status">
          {success}
        </p>
      )}
      {restore.error && <p className="form-error">{errorMessage(restore.error)}</p>}
    </div>
  );
}

function FolderSettings({
  folder,
  devices,
  canPickDirectories,
  nodeName,
  onChanged,
  onRemove,
}: {
  folder: Folder;
  devices: Device[];
  canPickDirectories: boolean;
  nodeName: string;
  onChanged: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState({
    label: folder.label,
    type: folder.type,
    versioningDays: String(folder.versioningDays),
    deviceIds: folder.deviceIds,
  });
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [saved, setSaved] = useState('');
  const [directory, setDirectory] = useState<SelectedDirectory>();
  const [moveConfirmed, setMoveConfirmed] = useState(false);
  const [ignoreText, setIgnoreText] = useState('');
  const [ignoreEdited, setIgnoreEdited] = useState(false);
  const source = useRef(folder);
  useUnsavedChanges(Boolean(dirty.size || directory || ignoreEdited));
  const ignores = useQuery({
    queryKey: ['folder-ignores', folder.id],
    queryFn: () => api.folderIgnores(folder.id),
  });
  const errors = useQuery({
    queryKey: ['folder-errors', folder.id],
    queryFn: () => api.folderErrors(folder.id),
    enabled: folder.errorCount > 0,
  });
  useEffect(() => {
    const previous = source.current;
    if (
      (dirty.has('label') && previous.label !== folder.label) ||
      (dirty.has('type') && previous.type !== folder.type) ||
      (dirty.has('versioningDays') && previous.versioningDays !== folder.versioningDays) ||
      (dirty.has('deviceIds') && previous.deviceIds.join('\0') !== folder.deviceIds.join('\0')) ||
      (directory && previous.pathLabel !== folder.pathLabel)
    ) {
      setRemoteChanged(true);
    } else if (!dirty.size && !directory) {
      setRemoteChanged(false);
    }
    setDraft((current) => ({
      label: dirty.has('label') ? current.label : folder.label,
      type: dirty.has('type') ? current.type : folder.type,
      versioningDays: dirty.has('versioningDays')
        ? current.versioningDays
        : String(folder.versioningDays),
      deviceIds: dirty.has('deviceIds') ? current.deviceIds : folder.deviceIds,
    }));
    source.current = folder;
  }, [directory, dirty, folder]);
  useEffect(() => {
    if (ignores.data && !ignoreEdited) setIgnoreText(ignores.data.lines.join('\n'));
  }, [ignoreEdited, ignores.data]);

  const update = useMutation({
    mutationFn: api.updateFolder.bind(api, folder.id),
    onSuccess: () => {
      setDirty(new Set());
      setRemoteChanged(false);
      setDirectory(undefined);
      setMoveConfirmed(false);
      setSaved('文件夹设置已保存');
      onChanged();
    },
  });
  const saveIgnores = useMutation({
    mutationFn: () => api.updateFolderIgnores(folder.id, { lines: ignoreText.split('\n') }),
    onSuccess: () => {
      setIgnoreEdited(false);
      setSaved('忽略规则已保存');
      void ignores.refetch();
    },
  });
  const divergence = useMutation({
    mutationFn: () =>
      folder.type === 'sendonly' ? api.overrideFolder(folder.id) : api.revertFolder(folder.id),
    onSuccess: (result) => {
      setSaved(result.message);
      onChanged();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (directory && !moveConfirmed) {
      setSaved('请先确认新目录内容完整，再更新文件夹位置');
      return;
    }
    update.mutate({
      ...(dirty.has('label') ? { label: draft.label.trim() } : {}),
      ...(dirty.has('type') ? { type: draft.type } : {}),
      ...(dirty.has('versioningDays') ? { versioningDays: Number(draft.versioningDays) } : {}),
      ...(dirty.has('deviceIds') ? { deviceIds: draft.deviceIds } : {}),
      ...(directory ? { directoryId: directory.id, confirmDirectoryMove: true } : {}),
    });
  }

  function mark(key: string, changed: boolean) {
    setDirty((current) => {
      const next = new Set(current);
      if (changed) next.add(key);
      else next.delete(key);
      return next;
    });
    setSaved('');
  }

  return (
    <div className="folder-settings">
      {folder.pathConflicts?.length ? (
        <div className="folder-error" role="alert">
          <strong>同步目录存在重叠配置</strong>
          <p>
            与 {folder.pathConflicts.map((item) => `“${item.label}”`).join('、')}
            使用同一目录或父子目录。请暂停后修改位置，或移除其中一个配置。
          </p>
        </div>
      ) : null}
      {remoteChanged && (
        <p className="notice-banner" role="status">
          文件夹配置在编辑期间发生了变化；未编辑字段已更新，当前草稿仍保留，请保存前重新核对。
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-grid three-columns">
          <label>
            显示名称
            <input
              required
              value={draft.label}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft({ ...draft, label: value });
                mark('label', value.trim() !== folder.label);
              }}
            />
          </label>
          <label>
            同步方向
            <select
              value={draft.type}
              onChange={(event) => {
                const value = event.currentTarget.value as FolderType;
                setDraft({ ...draft, type: value });
                mark('type', value !== folder.type);
              }}
            >
              <option value="sendreceive">双向同步</option>
              <option value="sendonly">仅发送</option>
              <option value="receiveonly">仅接收</option>
            </select>
          </label>
          <label>
            版本保留天数
            <input
              type="number"
              required
              min="0"
              max="3650"
              value={draft.versioningDays}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft({ ...draft, versioningDays: value });
                mark('versioningDays', value === '' || Number(value) !== folder.versioningDays);
              }}
            />
          </label>
        </div>
        <fieldset className="device-choices inline-choices">
          <legend>同步设备</legend>
          {devices.map((device) => (
            <label key={device.id}>
              <input
                type="checkbox"
                checked={draft.deviceIds.includes(device.id)}
                onChange={(event) => {
                  const deviceIds = event.currentTarget.checked
                    ? [...draft.deviceIds, device.id]
                    : draft.deviceIds.filter((id) => id !== device.id);
                  setDraft({
                    ...draft,
                    deviceIds,
                  });
                  mark(
                    'deviceIds',
                    [...deviceIds].sort().join('\0') !== [...folder.deviceIds].sort().join('\0'),
                  );
                }}
              />
              <span>{device.name}</span>
            </label>
          ))}
        </fieldset>
        <section className="folder-setting-section">
          <h3>目录已移动</h3>
          <p>
            先暂停同步并手动移动或核对文件，再选择新目录。KiteSync
            只更新路径，不会移动、覆盖或删除文件。
          </p>
          {folder.paused ? (
            <>
              <DirectoryPicker
                selected={directory}
                native={canPickDirectories}
                nodeName={nodeName}
                onSelect={(selection) => {
                  setDirectory(selection);
                  setMoveConfirmed(false);
                }}
              />
              {directory && (
                <label className="confirmation-row">
                  <input
                    type="checkbox"
                    checked={moveConfirmed}
                    onChange={(event) => setMoveConfirmed(event.currentTarget.checked)}
                  />
                  <span>我已手动移动或核对文件，并确认新目录内容完整</span>
                </label>
              )}
            </>
          ) : (
            <p className="panel-note">请先从“操作”菜单暂停文件夹。</p>
          )}
        </section>
        {update.error && <p className="form-error">{errorMessage(update.error)}</p>}
        <div className="form-actions split-actions">
          <button type="button" className="danger-link" onClick={onRemove}>
            移除同步文件夹
          </button>
          <Button
            disabled={
              update.isPending ||
              (!dirty.size && !directory) ||
              Boolean(directory && !moveConfirmed)
            }
          >
            {update.isPending ? '正在保存…' : '保存更改'}
          </Button>
        </div>
      </form>

      {(folder.type === 'sendonly' || folder.type === 'receiveonly') && (
        <section className="folder-setting-section">
          <h3>处理单向同步分歧</h3>
          <p>
            {folder.type === 'sendonly'
              ? `以 ${nodeName} 的内容覆盖远端变化。远端未同步的修改可能被替换。`
              : `还原 ${nodeName} 在仅接收目录中的本机变化，使其重新匹配全局内容。`}
          </p>
          <Button
            className="secondary-button"
            disabled={divergence.isPending}
            onClick={() => {
              const action = folder.type === 'sendonly' ? '覆盖远端变化' : '还原本机变化';
              if (window.confirm(`确认${action}吗？操作提交后请等待同步状态完成。`)) {
                divergence.mutate();
              }
            }}
          >
            {folder.type === 'sendonly' ? '覆盖远端变化' : '还原本机变化'}
          </Button>
        </section>
      )}

      <section className="folder-setting-section">
        <h3>忽略规则</h3>
        <p>
          保留注释和顺序。已有 #include 可查看和原样保留，但不能新增、改写或从此处读取外部 include
          文件。
        </p>
        {ignores.isLoading ? (
          <p className="muted-line">正在读取忽略规则…</p>
        ) : (
          <textarea
            className="ignore-editor"
            rows={10}
            value={ignoreText}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setIgnoreText(value);
              setIgnoreEdited(value !== (ignores.data?.lines.join('\n') ?? ''));
            }}
            spellCheck={false}
          />
        )}
        {ignores.data?.hasIncludes && (
          <p className="notice-banner">
            规则包含 #include；未修改的 include 行可保存，但此处不会读取目标文件。
          </p>
        )}
        <Button
          className="secondary-button"
          disabled={!ignoreEdited || saveIgnores.isPending}
          onClick={() => saveIgnores.mutate()}
        >
          保存忽略规则
        </Button>
        {(ignores.error || saveIgnores.error) && (
          <p className="form-error">{errorMessage(ignores.error ?? saveIgnores.error)}</p>
        )}
      </section>

      {folder.errorCount > 0 && (
        <section className="folder-setting-section">
          <h3>失败文件详情</h3>
          {errors.isLoading && <p className="muted-line">正在读取失败项目…</p>}
          {errors.data?.items.map((item) => (
            <div className="error-row" key={item.path}>
              <b>{item.path}</b>
              <span>{item.message}</span>
            </div>
          ))}
          {errors.error && <p className="form-error">{errorMessage(errors.error)}</p>}
        </section>
      )}
      {(saved || divergence.error) && (
        <p className={divergence.error ? 'form-error' : 'success-message'} role="status">
          {divergence.error ? errorMessage(divergence.error) : saved}
        </p>
      )}
    </div>
  );
}

function syncProgress(localBytes: number, needBytes: number) {
  const total = localBytes + needBytes;
  return total === 0 ? 100 : Math.round((localBytes / total) * 100);
}

function folderProgressText(folder: Folder, nodeName: string) {
  if (folder.paused) return '同步已暂停';
  if (folder.error) return '状态不可用';
  if ((folder.receiveOnlyChangedItems ?? 0) > 0) {
    return `${nodeName} 有 ${folder.receiveOnlyChangedItems} 项本机变化`;
  }
  if ((folder.needItems ?? 0) > 0 || folder.needBytes > 0 || (folder.needDeletes ?? 0) > 0) {
    return `待处理 ${folder.needItems ?? 0} 项 · ${folder.needDeletes ?? 0} 个删除 · ${formatBytes(folder.needBytes)}`;
  }
  if (!folder.deviceIds.length) return `仅 ${nodeName}`;
  if (!folder.peerProgress || folder.peerProgress.length < folder.deviceIds.length)
    return '同步状态未知';
  if (folder.peerProgress.some((peer) => peer.remoteState === 'unknown')) return '远端状态未知';
  const awaitingConfirmation = folder.peerProgress.filter(
    (peer) => peer.remoteState === 'notSharing',
  ).length;
  if (awaitingConfirmation) return `等待 ${awaitingConfirmation} 台设备确认共享`;
  const pausedPeers = folder.peerProgress.filter((peer) => peer.remoteState === 'paused').length;
  if (pausedPeers) return `${pausedPeers} 台远端设备已暂停`;
  const waiting = folder.peerProgress.filter(
    (peer) =>
      peer.remoteState !== 'valid' ||
      peer.completion < 100 ||
      peer.needItems > 0 ||
      peer.needDeletes > 0,
  );
  return waiting.length ? `等待 ${waiting.length} 台远端设备完成` : '所有共享设备已同步';
}

function folderStatusName(folder: Folder) {
  if (folder.errorCode === 'marker_missing') return '目录需确认';
  if (folder.errorCode === 'path_missing') return '目录不可用';
  if (folder.errorCode === 'access_denied') return '权限受限';
  if (folder.errorCode === 'disk_full') return '空间不足';
  if (folder.errorCode === 'watch_failed') return '监视失败';
  if (folder.errorCode === 'file_errors') return '部分文件失败';
  if (!folder.deviceIds.length && folder.state === 'idle') return '仅此节点';
  if ((folder.receiveOnlyChangedItems ?? 0) > 0) return '本机有分歧';
  if (
    folder.state === 'idle' &&
    (!folder.peerProgress ||
      folder.peerProgress.length < folder.deviceIds.length ||
      folder.peerProgress.some((peer) => peer.remoteState === 'unknown'))
  )
    return '状态未知';
  if (folder.peerProgress?.some((peer) => ['paused', 'notSharing'].includes(peer.remoteState)))
    return '等待远端';
  if ((folder.needItems ?? 0) > 0 || (folder.needDeletes ?? 0) > 0 || folder.needBytes > 0)
    return '等待同步';
  return folderStateNames[folder.state];
}

function folderProblemTitle(folder: Folder) {
  if (folder.errorCode === 'marker_missing') return '请先确认同步目录';
  if (folder.errorCode === 'path_missing') return '找不到同步目录';
  if (folder.errorCode === 'access_denied') return '没有目录访问权限';
  if (folder.errorCode === 'disk_full') return '磁盘空间不足';
  if (folder.errorCode === 'watch_failed') return '无法实时监视文件变化';
  if (folder.errorCode === 'file_errors') return `${folder.errorCount} 个项目需要处理`;
  if (folder.errorCode === 'status_unavailable') return '无法读取同步状态';
  return '同步文件夹无法运行';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : '操作失败，请重试';
}

function deviceFingerprint(id: string) {
  const compact = id.replaceAll('-', '').slice(0, 12);
  return compact.length > 6 ? `${compact.slice(0, 6)} ${compact.slice(6)}` : compact;
}
