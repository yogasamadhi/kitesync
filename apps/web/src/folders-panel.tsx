import { useState, type FormEvent } from 'react';
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

export function FoldersPanel({ canRevealFiles }: { canRevealFiles: boolean }) {
  const queryClient = useQueryClient();
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.folders });
  const pending = useQuery({ queryKey: ['folders', 'pending'], queryFn: api.pendingFolders });
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['folders'] });
  const queryError = folders.error ?? pending.error ?? devices.error;

  return (
    <div className="stack">
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
                onChanged={refresh}
              />
            ))}
          </div>
        </section>
      )}

      <NewFolderCard devices={devices.data?.items ?? []} onChanged={refresh} />

      <section>
        <div className="section-heading">
          <h2>我的同步文件夹</h2>
          <span>{folders.data?.items.length ?? 0}</span>
        </div>
        <div className="folder-list">
          {folders.isLoading ? (
            <Card className="quiet-card">正在读取同步文件夹…</Card>
          ) : folders.data?.items.length ? (
            folders.data.items.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                devices={devices.data?.items ?? []}
                canRevealFiles={canRevealFiles}
                onChanged={refresh}
              />
            ))
          ) : (
            <Card>
              <EmptyState
                title="还没有同步文件夹"
                detail="从本机选择一个目录，然后勾选要同步到的设备。"
              />
            </Card>
          )}
        </div>
      </section>
      {queryError && <p className="form-error">{errorMessage(queryError)}</p>}
    </div>
  );
}

function NewFolderCard({ devices, onChanged }: { devices: Device[]; onChanged: () => void }) {
  const [directory, setDirectory] = useState<SelectedDirectory>();
  const create = useMutation({
    mutationFn: api.createFolder,
    onSuccess: () => {
      setDirectory(undefined);
      onChanged();
    },
  });

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
          <p>路径只在这台电脑上保存，不会发送给其他设备。</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid two-columns">
          <label>
            显示名称
            <input name="label" required maxLength={128} placeholder="例如：家庭照片" />
          </label>
          <label>
            同步方向
            <select name="type" defaultValue="sendreceive">
              <option value="sendreceive">双向同步</option>
              <option value="sendonly">仅从此节点发送</option>
              <option value="receiveonly">仅在此节点接收</option>
            </select>
          </label>
        </div>
        <DirectoryPicker selected={directory} onSelect={setDirectory} />
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
            <p>尚未配对设备。可以先只在本机创建，稍后再添加设备。</p>
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

function PendingFolderCard({ offer, onChanged }: { offer: PendingFolder; onChanged: () => void }) {
  const [directory, setDirectory] = useState<SelectedDirectory>();
  const [type, setType] = useState<FolderType>('sendreceive');
  const accept = useMutation({
    mutationFn: () =>
      api.acceptPendingFolder(offer.deviceId, offer.folderId, {
        directoryId: directory!.id,
        type,
      }),
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
        <summary>选择保存位置并接受</summary>
        <DirectoryPicker selected={directory} onSelect={setDirectory} />
        <label>
          此节点的同步方向
          <select value={type} onChange={(event) => setType(event.target.value as FolderType)}>
            <option value="sendreceive">双向同步</option>
            <option value="sendonly">仅从此节点发送</option>
            <option value="receiveonly">仅在此节点接收</option>
          </select>
        </label>
        <div className="row-actions">
          <button
            className="ghost-button"
            disabled={accept.isPending || reject.isPending}
            onClick={() => reject.mutate()}
          >
            拒绝
          </button>
          <Button disabled={!directory || accept.isPending} onClick={() => accept.mutate()}>
            接受共享
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
  onChanged,
}: {
  folder: Folder;
  devices: Device[];
  canRevealFiles: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'files' | 'versions' | 'settings'>('files');
  const pause = useMutation({
    mutationFn: () => (folder.paused ? api.resumeFolder(folder.id) : api.pauseFolder(folder.id)),
    onSuccess: onChanged,
  });
  const scan = useMutation({ mutationFn: () => api.scanFolder(folder.id), onSuccess: onChanged });
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
            <h2>{folder.label}</h2>
            <Badge tone={folder.state === 'error' ? 'warn' : folder.paused ? 'neutral' : 'good'}>
              {folderStateNames[folder.state]}
            </Badge>
          </div>
          <p>{folder.pathLabel}</p>
          <small>
            {folderTypeNames[folder.type]} · {folder.deviceIds.length} 台设备 ·{' '}
            {formatBytes(folder.localBytes)}
          </small>
        </div>
        <div className="folder-progress">
          <span>{folder.needBytes ? `待同步 ${formatBytes(folder.needBytes)}` : '全部为最新'}</span>
          <div>
            <i
              style={{
                width: `${syncProgress(folder.localBytes, folder.needBytes)}%`,
              }}
            />
          </div>
        </div>
      </div>

      {folder.error && <p className="folder-error">{folder.error}</p>}

      <div className="folder-tabs" role="tablist">
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          浏览文件
        </button>
        <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
          历史版本
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          文件夹设置
        </button>
        <span />
        <button disabled={scan.isPending} onClick={() => scan.mutate()}>
          立即扫描
        </button>
        <button disabled={pause.isPending} onClick={() => pause.mutate()}>
          {folder.paused ? '继续同步' : '暂停'}
        </button>
      </div>

      {tab === 'files' && <ReadonlyFileBrowser folder={folder} canRevealFiles={canRevealFiles} />}
      {tab === 'versions' && <Versions folder={folder} />}
      {tab === 'settings' && (
        <FolderSettings
          folder={folder}
          devices={devices}
          onChanged={onChanged}
          onRemove={() => {
            if (window.confirm(`移除“${folder.label}”？本机文件不会被删除。`)) remove.mutate();
          }}
        />
      )}
      {(pause.error || scan.error || remove.error) && (
        <p className="form-error">{errorMessage(pause.error ?? scan.error ?? remove.error)}</p>
      )}
    </Card>
  );
}

function ReadonlyFileBrowser({
  folder,
  canRevealFiles,
}: {
  folder: Folder;
  canRevealFiles: boolean;
}) {
  const [path, setPath] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const files = useQuery({
    queryKey: ['folder-files', folder.id, path, cursor],
    queryFn: () => api.folderFiles(folder.id, path, { ...(cursor ? { cursor } : {}), limit: 100 }),
  });
  const reveal = useMutation({
    mutationFn: (itemPath: string) => api.revealFolderFile(folder.id, { path: itemPath }),
  });

  function navigate(nextPath: string) {
    setPath(nextPath);
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
        <Badge>只读浏览</Badge>
      </div>
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
    </div>
  );
}

function FileRow({
  item,
  folderId,
  canRevealFiles,
  revealing,
  onOpen,
  onReveal,
}: {
  item: FolderFile;
  folderId: string;
  canRevealFiles: boolean;
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
            在此节点打开
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

function Versions({ folder }: { folder: Folder }) {
  const versions = useQuery({
    queryKey: ['folder-versions', folder.id],
    queryFn: () => api.folderVersions(folder.id),
  });
  const restore = useMutation({
    mutationFn: (version: VersionEntry) =>
      api.restoreFolderVersion(folder.id, {
        path: version.path,
        versionTime: version.versionTime,
      }),
    onSuccess: () => void versions.refetch(),
  });

  return (
    <div className="versions-panel">
      <p className="panel-note">
        {folder.versioningDays === 0
          ? '此文件夹的历史版本已关闭。'
          : `历史版本保留 ${folder.versioningDays} 天。恢复前会保留当前文件，因此可以再次撤销。`}
      </p>
      {versions.isLoading && <p className="muted-line">正在读取历史版本…</p>}
      {versions.data?.items.length ? (
        versions.data.items.map((version) => (
          <div className="version-row" key={`${version.path}:${version.versionTime}`}>
            <span className="file-glyph">↶</span>
            <div>
              <b>{version.path}</b>
              <small>
                {formatDate(version.versionTime)} · {formatBytes(version.size)}
              </small>
            </div>
            <Button
              className="secondary-button"
              disabled={restore.isPending}
              onClick={() => {
                if (window.confirm(`恢复“${version.path}”的这个版本吗？`)) restore.mutate(version);
              }}
            >
              恢复此版本
            </Button>
          </div>
        ))
      ) : versions.data ? (
        <EmptyState title="暂无历史版本" detail="文件发生修改后，旧版本会在这里出现。" />
      ) : null}
      {restore.error && <p className="form-error">{errorMessage(restore.error)}</p>}
    </div>
  );
}

function FolderSettings({
  folder,
  devices,
  onChanged,
  onRemove,
}: {
  folder: Folder;
  devices: Device[];
  onChanged: () => void;
  onRemove: () => void;
}) {
  const update = useMutation({
    mutationFn: api.updateFolder.bind(api, folder.id),
    onSuccess: onChanged,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update.mutate({
      label: String(form.get('label') ?? '').trim(),
      type: String(form.get('type')) as FolderType,
      versioningDays: Number(form.get('versioningDays')),
      deviceIds: form.getAll('deviceId').map(String),
    });
  }

  return (
    <form className="folder-settings" onSubmit={submit}>
      <div className="form-grid three-columns">
        <label>
          显示名称
          <input name="label" required defaultValue={folder.label} />
        </label>
        <label>
          同步方向
          <select name="type" defaultValue={folder.type}>
            <option value="sendreceive">双向同步</option>
            <option value="sendonly">仅发送</option>
            <option value="receiveonly">仅接收</option>
          </select>
        </label>
        <label>
          版本保留天数
          <input
            name="versioningDays"
            type="number"
            min="0"
            max="3650"
            defaultValue={folder.versioningDays}
          />
        </label>
      </div>
      <fieldset className="device-choices inline-choices">
        <legend>同步设备</legend>
        {devices.map((device) => (
          <label key={device.id}>
            <input
              type="checkbox"
              name="deviceId"
              value={device.id}
              defaultChecked={folder.deviceIds.includes(device.id)}
            />
            <span>{device.name}</span>
          </label>
        ))}
      </fieldset>
      {update.error && <p className="form-error">{errorMessage(update.error)}</p>}
      <div className="form-actions split-actions">
        <button type="button" className="danger-link" onClick={onRemove}>
          移除同步文件夹
        </button>
        <Button disabled={update.isPending}>{update.isPending ? '正在保存…' : '保存更改'}</Button>
      </div>
    </form>
  );
}

function syncProgress(localBytes: number, needBytes: number) {
  const total = localBytes + needBytes;
  return total === 0 ? 100 : Math.round((localBytes / total) * 100);
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
