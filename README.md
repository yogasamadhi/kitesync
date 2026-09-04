# KiteSync

KiteSync 是一个局域网优先的点对点文件同步应用。Windows、macOS 和 Linux 运行相同的
KiteSync Node；任意两台节点都可以直接同步。所谓“中心节点”只是一个可选的、长期在线的
普通 Linux peer，不拥有账户、权限或数据面的特殊权威。

KiteSync 使用 Syncthing 作为同步引擎，并提供更聚焦的中文管理界面：设备指纹确认、文件夹
邀请、同步模式、版本恢复以及经认证的只读文件浏览。Syncthing REST 始终只监听本机回环地址。

## 本地开发

开发只要求 Bun 1.4+ 与 Go 1.26.x，不要求 Docker、Node.js、PostgreSQL 或 MinIO：

```bash
bun run bootstrap
bun run dev:all
```

`bootstrap` 严格按“初始化固定 Syncthing 源码 → frozen lockfile 安装 → 构建本机 sidecar”的顺序
准备全新 clone；默认开发、检查和 integration 都直接运行在宿主机，不启动 Docker。

管理页默认位于 `http://127.0.0.1:3210`。首次使用需要设置当前节点的管理员密码；桌面快捷方式
通过本机一次性 open token 打开已有会话。

常用验证命令：

```bash
bun run check
bun run build
bun run test:integration
bun run predev && bun run test:e2e
bun run licenses:check
```

## 安装与部署

- Windows x64：NSIS 安装器；
- macOS 13+ x64/arm64：`/Applications/KiteSync.app` 与签名安装包；
- Linux x64/arm64：`.deb`、`.rpm`，支持桌面 user service 与常在线 system service；
- Docker：仅作为 Linux 常在线节点的可选单容器运行方式。

终端用户不需要安装 Bun、Node.js、Go 或 Docker。发行包包含 Bun 编译的 KiteSync 主程序和独立
签名的 Syncthing sidecar。

可选容器开发验证：

```bash
export KITESYNC_DATA_DIR=/srv/kitesync-data
export KITESYNC_ADMIN_PASSWORD_SECRET_FILE=/etc/kitesync/admin-password
bun run docker:up
bun run docker:logs
```

容器固定以 UID/GID `10001:10001` 运行，数据目录需要可写，管理员密码源文件需要由该 UID
只读。Linux 上推荐 host network 以使用 LAN discovery；bridge 网络的数据面必须显式映射同步
端口并使用静态 peer 地址，管理页则只映射到主机 `127.0.0.1`，或放在已配置的 HTTPS 反向代理
后面。

## 网络与安全边界

- 默认 UI 仅监听 `127.0.0.1:3210`/`::1`；设置管理员密码后才可开启 LAN 访问。
- LAN discovery 使用 UDP 21027；同步数据面通常使用 TCP/UDP 22000。
- 全局发现、Relay、NAT/STUN、遥测和 Syncthing 自升级保持关闭。
- 直接 HTTP 只适用于可信局域网。公网访问必须由外部反向代理终止 HTTPS。
- 反向代理只承载管理页和只读下载，不为 Syncthing 数据面提供互联网穿透。

详细设计与操作说明：

- `docs/architecture/KITESYNC_P2P_NODE_ARCHITECTURE.md`
- `docs/architecture/node/NODE_SERVICE.md`
- `docs/operations/DEVELOPMENT.md`
- `docs/operations/PRODUCTION_RUNBOOK.md`
- `docs/operations/RELEASE.md`
- `docs/operations/LEGACY_CLEANUP.md`

Syncthing `v2.1.3` 源码固定在 `vendor/syncthing/upstream`，使用 Go 1.26、只读 module 模式和
确定的构建元数据自行构建。发行包同时携带 MPL-2.0 许可证与源码地址。
