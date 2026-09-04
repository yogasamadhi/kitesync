import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState } from '@kitesync/ui';
import type {
  Device,
  DiscoveredDevice,
  NodeInfo,
  PendingDevice,
  UpdateDeviceRequest,
} from '@kitesync/contracts';
import { api } from './api.js';

export function DevicesPanel({ node }: { node: NodeInfo }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const devices = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const discovered = useQuery({
    queryKey: ['devices', 'discovered'],
    queryFn: api.discoveredDevices,
  });
  const pending = useQuery({ queryKey: ['devices', 'pending'], queryFn: api.pendingDevices });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['devices'] });

  const add = useMutation({ mutationFn: api.createDevice, onSuccess: refresh });
  const accept = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) =>
      api.acceptPendingDevice(id, name ? { name } : {}),
    onSuccess: refresh,
  });
  const reject = useMutation({ mutationFn: api.rejectPendingDevice, onSuccess: refresh });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateDeviceRequest }) =>
      api.updateDevice(id, input),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.removeDevice, onSuccess: refresh });
  const unignore = useMutation({ mutationFn: api.unignoreDevice, onSuccess: refresh });

  const mutationError =
    add.error ?? accept.error ?? reject.error ?? update.error ?? remove.error ?? unignore.error;
  const queryError = devices.error ?? discovered.error ?? pending.error;

  async function copyDeviceId() {
    try {
      await navigator.clipboard.writeText(node.deviceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('请复制此设备 ID', node.deviceId);
    }
  }

  function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const addresses = String(form.get('addresses') ?? '')
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    const base = {
      deviceId: String(form.get('deviceId') ?? '').trim(),
      name: String(form.get('name') ?? '').trim(),
    };
    add.mutate(addresses.length ? { ...base, addresses } : base, {
      onSuccess: () => formElement.reset(),
    });
  }

  return (
    <div className="stack">
      <Card className="identity-card">
        <div>
          <p className="eyebrow">本机身份</p>
          <h2>让另一台设备添加此 ID</h2>
          <p>两边都确认设备后才会建立同步连接。</p>
        </div>
        <div className="identity-value">
          <div>
            <small>短指纹：{deviceFingerprint(node.deviceId)}</small>
            <code>{node.deviceId}</code>
          </div>
          <Button className="secondary-button" onClick={() => void copyDeviceId()}>
            {copied ? '已复制' : '复制 ID'}
          </Button>
        </div>
      </Card>

      {(pending.data?.items.length ?? 0) > 0 && (
        <section>
          <SectionHeading title="待确认设备" count={pending.data?.items.length ?? 0} />
          <div className="card-list">
            {pending.data?.items.map((device) => (
              <PendingDeviceCard
                key={device.id}
                device={device}
                busy={accept.isPending || reject.isPending}
                onAccept={(name) => accept.mutate({ id: device.id, ...(name ? { name } : {}) })}
                onReject={() => reject.mutate(device.id)}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeading title="局域网中发现" count={discovered.data?.items.length ?? 0} />
        <div className="card-list">
          {discovered.isLoading ? (
            <Card className="quiet-card">正在扫描局域网…</Card>
          ) : discovered.data?.items.length ? (
            discovered.data.items.map((device) => (
              <DiscoveredDeviceCard
                key={device.id}
                device={device}
                busy={add.isPending}
                onAdd={(name) =>
                  add.mutate({
                    deviceId: device.id,
                    name,
                  })
                }
              />
            ))
          ) : (
            <Card>
              <EmptyState
                title="暂未发现新设备"
                detail="请确认另一台电脑已打开 KiteSync，并与当前电脑位于同一局域网。"
              />
            </Card>
          )}
        </div>
      </section>

      <Card>
        <div className="card-heading compact-heading">
          <div>
            <h2>手动添加设备</h2>
            <p>局域网发现不可用时，可粘贴另一台电脑显示的设备 ID。</p>
          </div>
        </div>
        <form className="manual-device-form" onSubmit={addManual}>
          <label>
            设备名称
            <input name="name" required maxLength={64} placeholder="例如：办公室 Mac" />
          </label>
          <label className="wide-field">
            设备 ID
            <input name="deviceId" required minLength={32} spellCheck={false} />
          </label>
          <label className="wide-field">
            地址（可选）
            <input name="addresses" placeholder="留空自动连接，或填写 tcp://192.168.1.20:22000" />
          </label>
          <Button disabled={add.isPending}>{add.isPending ? '正在添加…' : '添加设备'}</Button>
        </form>
      </Card>

      <section>
        <SectionHeading title="已配对设备" count={devices.data?.items.length ?? 0} />
        <div className="card-list">
          {devices.data?.items.length ? (
            devices.data.items.map((device) => (
              <PairedDeviceCard
                key={device.id}
                device={device}
                busy={update.isPending || remove.isPending}
                onUpdate={(input) => update.mutate({ id: device.id, input })}
                onRemove={() => remove.mutate(device.id)}
              />
            ))
          ) : (
            <Card>
              <EmptyState title="还没有配对设备" detail="从上方发现列表添加，或手动输入设备 ID。" />
            </Card>
          )}
        </div>
      </section>

      {(pending.data?.ignored.length ?? 0) > 0 && (
        <details className="ignored-devices">
          <summary>已忽略的设备（{pending.data?.ignored.length}）</summary>
          {pending.data?.ignored.map((device) => (
            <div className="ignored-row" key={device.id}>
              <span>
                <b>{device.name}</b>
                <small>{shortId(device.id)}</small>
              </span>
              <button onClick={() => unignore.mutate(device.id)}>不再忽略</button>
            </div>
          ))}
        </details>
      )}

      {(queryError || mutationError) && (
        <p className="form-error">{errorMessage(queryError ?? mutationError)}</p>
      )}
    </div>
  );
}

function PairedDeviceCard({
  device,
  busy,
  onUpdate,
  onRemove,
}: {
  device: Device;
  busy: boolean;
  onUpdate: (input: UpdateDeviceRequest) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [addresses, setAddresses] = useState(
    device.addresses.filter((address) => address !== 'dynamic').join('\n'),
  );

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextAddresses = addresses
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    onUpdate({ name: name.trim(), addresses: nextAddresses });
  }

  return (
    <Card className={`device-card ${editing ? 'editing' : ''}`}>
      <div className={`device-avatar ${device.connected ? 'online' : ''}`}>
        {device.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="device-main">
        <div className="row-title">
          <h3>{device.name}</h3>
          <Badge tone={device.connected ? 'good' : 'neutral'}>
            {device.connected ? '已连接' : '离线'}
          </Badge>
          {device.paused && <Badge tone="warn">已暂停</Badge>}
        </div>
        <code title={device.id}>{device.id}</code>
        <small className="device-fingerprint">短指纹：{deviceFingerprint(device.id)}</small>
        <small>
          {device.connected
            ? device.addresses.join(' · ')
            : device.lastSeenAt
              ? `上次在线 ${formatDate(device.lastSeenAt)}`
              : '尚未连接'}
        </small>
      </div>
      <div className="device-actions">
        <button
          className="ghost-button"
          disabled={busy}
          onClick={() => onUpdate({ paused: !device.paused })}
        >
          {device.paused ? '继续' : '暂停'}
        </button>
        <button
          className="ghost-button"
          disabled={busy}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? '收起' : '编辑'}
        </button>
        <button
          className="danger-link"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `确定移除设备“${device.name}”吗？\n\n设备 ID：${device.id}\n\n这只会停止后续同步，不会、也不能删除对方设备上已有的文件。`,
              )
            ) {
              onRemove();
            }
          }}
        >
          移除
        </button>
      </div>
      {editing && (
        <form className="device-edit-form" onSubmit={save}>
          <label>
            设备名称
            <input
              required
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            静态地址（可选）
            <textarea
              rows={2}
              value={addresses}
              placeholder="留空使用 dynamic，或每行填写一个 tcp://IP:port"
              onChange={(event) => setAddresses(event.target.value)}
            />
          </label>
          <Button disabled={busy || !name.trim()}>{busy ? '正在保存…' : '保存修改'}</Button>
        </form>
      )}
    </Card>
  );
}

function PendingDeviceCard({
  device,
  busy,
  onAccept,
  onReject,
}: {
  device: PendingDevice;
  busy: boolean;
  onAccept: (name: string) => void;
  onReject: () => void;
}) {
  const [name, setName] = useState(device.name);
  return (
    <Card className="request-card">
      <div className="request-mark">?</div>
      <div>
        <h3>{device.name}</h3>
        <small>短指纹：{deviceFingerprint(device.id)}</small>
        <code>{device.id}</code>
        <small>
          {device.address} · {formatDate(device.seenAt)}
        </small>
      </div>
      <label>
        显示名称
        <input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="row-actions">
        <button className="ghost-button" disabled={busy} onClick={onReject}>
          拒绝并忽略
        </button>
        <Button disabled={busy || !name.trim()} onClick={() => onAccept(name.trim())}>
          接受
        </Button>
      </div>
    </Card>
  );
}

function DiscoveredDeviceCard({
  device,
  busy,
  onAdd,
}: {
  device: DiscoveredDevice;
  busy: boolean;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState(`局域网设备 ${device.id.slice(0, 7)}`);
  return (
    <Card className="discovered-card">
      <span className="radar-dot" />
      <div>
        <h3>短指纹：{deviceFingerprint(device.id)}</h3>
        <small>{device.addresses.join(' · ') || '动态地址'}</small>
        <details className="device-id-details">
          <summary>查看完整设备 ID</summary>
          <code>{device.id}</code>
        </details>
      </div>
      <input
        aria-label="设备名称"
        value={name}
        maxLength={64}
        onChange={(event) => setName(event.target.value)}
      />
      <Button disabled={busy || !name.trim()} onClick={() => onAdd(name.trim())}>
        添加
      </Button>
    </Card>
  );
}

function SectionHeading({ title, count = 0 }: { title: string; count?: number }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      <span>{count}</span>
    </div>
  );
}

function shortId(id: string) {
  return id.length > 19 ? `${id.slice(0, 9)}…${id.slice(-7)}` : id;
}

function deviceFingerprint(id: string) {
  const compact = id.replaceAll('-', '').slice(0, 12);
  return compact.length > 6 ? `${compact.slice(0, 6)} ${compact.slice(6)}` : compact;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : '操作失败，请重试';
}
