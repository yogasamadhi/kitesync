# 节点运行手册

## 桌面节点

Windows/macOS/Linux 桌面安装包会安装同一个 KiteSync Node、Syncthing sidecar 和登录启动项。
首次双击应用会启动后台服务、等待健康并在系统浏览器打开 `127.0.0.1:3210`。重复双击复用同一
实例。

首次设置管理员密码后，用户才能开启 LAN 管理页。开启 LAN 时应只为可信私有网络放行：

- 管理 UI TCP 3210（可配置）；
- Syncthing TCP/UDP 22000 或界面显示的实际同步端口；
- LAN discovery UDP 21027。

Syncthing REST 8385 永远不应从其他主机访问。

设置页只提交实际修改的字段，并用 ETag 防止两个页面互相覆盖。遇到“另一页面已先保存设置”时，
重新加载或保留草稿逐项核对；不要重复点击保存。修改 LAN 访问后若当前连接中断，请使用新的本机
或 HTTPS 入口重新打开。

忘记管理密码时必须在节点本机终端运行交互式恢复，密码不会出现在命令参数或 shell 历史中：

```bash
kitesync password reset
sudo -u kitesync kitesync password reset --system
```

运行中的服务只接受直接 loopback 且带本机 open secret 的内部请求；服务停止时命令持有实例锁后
原子更新密码。两种方式都会撤销旧会话和未使用的打开令牌，并保留 Device ID、配对、文件夹配置
和同步数据。没有远程免旧密码重置入口。

## Linux 常在线节点

`.deb`/`.rpm` 同时提供 systemd user unit 和 system unit。桌面用户启用 user unit；headless
主机显式启用 system unit，后者使用专用 `kitesync` 用户与 `/var/lib/kitesync`。禁止两个 unit
共享同一状态目录或端口。

```bash
sudo kitesync service install --system
sudo -u kitesync kitesync setup --system
```

安装器不静默修改 ufw/firewalld。system node 必须用
`sudo -u kitesync env KITESYNC_STATE_DIR=/var/lib/kitesync kitesync identity` 查询身份，避免 root
在自己的 home 中误建另一套状态；再根据管理页网络状态确认实际端口并执行发行版对应的放行命令。

## 反向代理

公网或不可信网络必须由外部代理终止 HTTPS。先在节点设置中添加完整 HTTPS origin 与代理来源
IP/CIDR。默认只信任 loopback 转发头；不要使用宽泛的 `0.0.0.0/0` trusted proxy。

代理应保留 Host，并设置 `X-Forwarded-For`、`X-Forwarded-Host` 与
`X-Forwarded-Proto: https`；当前版本不解析 RFC `Forwarded`。同时关闭对
`/internal/open-token` 的转发。Cloudflare Tunnel 可作为通用 HTTPS 代理，但 KiteSync 不调用
Cloudflare API，且它不承载 Syncthing 数据面。

直接 HTTP LAN 页面会持续显示未加密警告。

## 可选 Docker

容器内同时运行 KiteSync 主程序和 Syncthing。Linux 推荐 host network：

```bash
install -d -m 750 ./data
sudo chown -R 10001:10001 ./data
printf '%s' 'replace-with-a-long-password' > ./admin-password
sudo chown 10001:10001 ./admin-password
sudo chmod 400 ./admin-password
export KITESYNC_DATA_DIR="$PWD/data"
export KITESYNC_ADMIN_PASSWORD_SECRET_FILE="$PWD/admin-password"
bun run docker:up
```

镜像固定以 `10001:10001` 运行，因此 bind mount 的数据目录必须允许该 UID/GID 读写。开启 LAN
UI 时必须使用只读 secret file 提供初始管理员密码；Compose 的本地 file secret 是 bind mount，
因此源文件也必须由 UID 10001 可读。Compose 默认进一步启用只读 rootfs、移除全部 Linux
capabilities、设置 `no-new-privileges`，只有 `/var/lib/kitesync`、`/data` 和受限的 `/tmp` 可写。
bridge 模式的数据面需要映射 TCP/QUIC 端口并给 peers 配置静态地址，Docker 广播边界通常不能
透明支持 discovery。管理页只应映射为 `127.0.0.1:3210:3210`，或经已配置 HTTPS origin 和
trusted proxy 的反向代理访问；把 3210 直接映射到 Docker 主机 LAN IP 时，容器接口并不拥有该
Host，安全校验可能按设计拒绝请求。

## 健康与故障

- `/health` 仅表示 Node Service 存活；管理页显示 Syncthing 健康和实际监听地址。
- Node Service 断开时页面保留最后一次成功数据并标明过期时间；Syncthing 异常、设备离线、正在
  重连和文件夹暂停分别显示，不能把 `idle` 或剩余字节为零单独当成全部为最新。
- 文件夹进度同时检查待处理项目、待删除项目、仅接收本机分歧和各共享设备完成度。没有共享设备
  显示“仅本节点”，上游信息不足时显示“状态未知”。
- 磁盘不足、扫描错误、conflict 和 paused 状态直接来自 Syncthing。设置页可查看轮转后的节点事件
  日志和白名单诊断摘要，并下载已移除凭据、绝对路径和设备标识的诊断 JSON。
- 节点日志默认每个文件 5 MiB，保留 3 份。故障工单优先使用脱敏诊断导出，不要发送完整
  Syncthing support bundle、`state.json`、Cookie、CSRF、open secret 或 API key。
- 解除配对不会删除远端已有文件；删除 folder 配置不会删除本机目录。
- 没有中央撤销或审计。敏感数据泄露时必须在每个 peer 上处理已有副本。
- 版本历史是本机副本，不替代离线备份。

升级和所有平台的卸载器都保留 state、Syncthing home、证书、Device ID 和同步目录；当前版本
没有 purge/reset 生产命令，也不会声称替用户销毁身份。

## 文件夹异常处理

KiteSync 拒绝新增同一物理目录以及祖先/后代重叠目录。历史配置如已重叠，管理页会列出关联
文件夹，管理员应暂停后修改位置或移除其中一项；系统不会自动删除、暂停或搬动数据。目录移动
必须按“暂停 → 在文件管理器中手动移动 → 重新选择目录 → 核对内容完整 → 更新位置”的顺序完成，
更新只修改 Syncthing 配置并保留 folder ID、设备、同步方向和版本设置。

暂停文件夹不能读取或恢复版本，需由管理员明确继续同步。历史版本主要由远端替换写入产生，不能
保证每次本机编辑都有副本。仅接收目录的本机分歧可提交还原，或用仅发送目录提交覆盖远端；提交
后仍要等待引擎状态确认完成。冲突列表和失败文件详情只读，可下载或在本机定位，由管理员人工
决定取舍。忽略规则保持注释和顺序；已有 `#include` 可查看，但管理页不会读取被包含文件。

## 人工销毁本机身份

确需销毁身份时，先导出备份并核对实际 `KITESYNC_STATE_DIR`。默认桌面路径分别为 Windows
`%LOCALAPPDATA%\KiteSync`（旧安装也可能在 `%APPDATA%\KiteSync`）、macOS
`~/Library/Application Support/KiteSync`、Linux `~/.local/state/kitesync`（旧安装也可能在
`~/.config/KiteSync`）；Linux system node 固定为 `/var/lib/kitesync`。按以下顺序操作：

1. 用 `kitesync service remove`（system node 加 `--system`）停止并禁用服务，确认没有
   `kitesync`/其 Syncthing 子进程；
2. 备份状态目录，并确认用户同步目录不在要移动的状态目录内；
3. 先把整个状态目录重命名为带日期的 `KiteSync.identity-quarantine-*`，不要直接删除；
4. 桌面节点重新打开 KiteSync；system node 再执行本节前述的 `service install --system` 与
   `setup --system`，确认生成了新 Device ID，并在所有 peers 上重新批准；
5. 经过观察期且确认备份可恢复后，再通过系统文件管理器人工删除隔离目录。

Linux system node 可用下面的可恢复操作完成第 3 步；它只接受固定确认词，并在移动前再次检查
Syncthing 身份文件。不要把 `state_dir` 改成 `/`、home 或同步数据目录：

```bash
set -eu
state_dir=/var/lib/kitesync
quarantine=/var/lib/kitesync.identity-quarantine-$(date +%Y%m%d-%H%M%S)
printf '输入 DESTROY KITESYNC IDENTITY 以隔离本机身份：'
read -r confirmation
test "$confirmation" = 'DESTROY KITESYNC IDENTITY' || exit 1
test "$(sudo realpath -- "$state_dir")" = "$state_dir"
sudo test -f "$state_dir/syncthing/cert.pem"
sudo test ! -e "$quarantine"
sudo mv -- "$state_dir" "$quarantine"
sudo install -d -o kitesync -g kitesync -m 0750 "$state_dir"
```

此流程不会删除同步目录或 peer 上的副本；旧隔离目录在人工删除前仍可用于回滚。
