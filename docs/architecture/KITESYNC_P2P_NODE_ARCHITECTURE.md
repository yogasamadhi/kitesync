# KiteSync P2P Node 架构

## 目标

每台 Windows、macOS 或 Linux 机器运行同一种 KiteSync Node。节点之间直接交换 Syncthing
配置和同步数据，不依赖中央账户、数据库或 Linux Hub。常在线 Linux 机器只是普通 peer，适合
承担额外副本和版本空间。

每个节点包含两个进程：

1. Bun 编译的 `kitesync` 主程序，负责管理 HTTP、认证、配置投影、文件浏览和进程监督；
2. 固定源码构建并单独签名的 `syncthing` sidecar，负责索引、传输、冲突和版本历史。

React 管理 UI 作为静态 asset 嵌入主程序，并由系统浏览器显示。不引入 Electron、Tauri、
PostgreSQL、SQLite 或其他应用数据库。

## 事实源和持久状态

Syncthing `config.xml` 是设备、文件夹、成员关系、同步模式、ignore 和 versioning 的唯一事实源。
KiteSync 不复制这些对象到第二套数据库，也不运行 desired/observed reconciliation。

KiteSync `state.json` 只保存 UI 监听模式、Argon2id 管理员密码哈希、允许的 HTTPS origins、
可信代理地址和少量偏好。写入流程必须是同目录临时文件、flush/fsync、原子 rename，并在 POSIX
平台使用 `0600`。会话只存在内存中，进程重启后失效。

Syncthing 证书决定 Device ID，KiteSync 直接使用该 ID 作为节点身份。升级和普通卸载必须保留
Syncthing home；身份被显式删除后，其他节点必须重新配对。

状态目录上的独占锁保证单实例。重复执行 `kitesync open` 只唤醒已运行服务和浏览器。

## 网络边界

| 接口                    | 默认监听                              | 用途                   |
| ----------------------- | ------------------------------------- | ---------------------- |
| KiteSync UI/API         | `127.0.0.1:3210`、`::1`               | 管理与只读文件下载     |
| Syncthing REST/GUI      | loopback `8385`                       | 仅供 Node Service 调用 |
| Syncthing sync          | TCP/QUIC `22000` 或首次选择的空闲端口 | 节点数据面             |
| Syncthing LAN discovery | UDP `21027`                           | 同一广播域发现         |

Node Service 启用 `localAnnounceEnabled` 和 LAN 地址公告，同时关闭 global discovery、Relay、
NAT、STUN、遥测和 Syncthing 自升级。已经由 Syncthing 选择的可用同步端口不得在每次启动时
覆写。跨 VLAN 使用完整 Device ID 与 `tcp://IP:port` 静态地址。

Syncthing REST 的随机 API key 只保存在本机状态中，REST 监听永远不能因 KiteSync LAN UI 开关
而暴露到局域网。

## 信任、配对和文件夹邀请

LAN discovery 只提供候选地址，不建立信任。UI 展示完整 Device ID 和短指纹，用户在两端明确
确认。新增设备固定使用 `autoAcceptFolders=false`、`introducer=false`，默认地址为 `dynamic`。

拒绝或解除设备时，Node Service 先从所有 folder members 移除设备，再删除 device，并写入
`remoteIgnoredDevices`。这个动作只撤销未来连接，无法擦除 peer 已获得的数据。

创建文件夹会产生稳定随机 folder ID。发送方选择本机目录、标签、模式与 peers；接收方只收到
folder ID、标签和来源设备，必须自己选择目录和模式。任何远端绝对路径都被忽略。拒绝邀请写入
设备的 `ignoredFolders`；删除文件夹配置不会删除磁盘内容。

默认模式为 `sendreceive`，高级模式为 `sendonly` 和 `receiveonly`。新建与接受的文件夹默认使用
staggered versioning，最大 30 天；关闭或修改保留期直接更新该文件夹的 Syncthing 配置。

## 管理页认证

首次本地访问设置每节点唯一管理员密码，使用 `Bun.password` Argon2id 保存 PHC hash。只有设置
密码后才允许把 UI 切换为 `0.0.0.0:3210`。远程访问使用 HttpOnly、SameSite session cookie，
所有修改请求必须携带 CSRF token，登录按来源限速并指数退避。

桌面快捷方式持有的本机 open secret 保存在 Windows DPAPI 或 macOS Keychain；Linux headless
节点使用 owner-only 文件。`/internal/open-token` 同时要求 loopback 来源和 open secret，并签发
一次性、短时有效 token。它在 LAN 模式下也不能远程调用。

Host/Origin 仅允许 loopback、本机私有或链路本地地址、本机 hostname/`.local` 和显式配置的
HTTPS origin。默认仅信任 loopback proxy；只有来自显式可信代理的 forwarded proto 才能令
Cookie 进入 Secure 模式。KiteSync 不管理 Cloudflare、DNS 或证书。

## 只读文件访问

文件 API 只接受 folder ID 和相对路径。每次访问均进行 URL 解码、路径规范化、`realpath` 根包含
校验和普通文件类型检查。符号链接、junction、根外目标及以下 Syncthing 元数据永不可见：

- `.stfolder`、`.stignore`、`.stversions`；
- `.syncthing.*`；
- `~syncthing~*`。

目录列表分页且有最大页长，下载支持 `HEAD` 和单段 HTTP Range。首版没有上传、编辑、重命名、
删除、目录 zip、公开链接或匿名访问。“在文件管理器中打开”只在被管理节点拥有桌面会话时显示，
并明确动作发生在远端节点。

## 去中心化限制

- 不提供多用户、角色、逐文件夹 ACL、全局审计或配额；登录节点管理员可访问该节点全部 folder。
- peer 之间的成员配置可能暂时不一致，不存在中心强制撤销。
- 无 global discovery/Relay/NAT 时，离开共同 LAN 后通常不会同步。
- 版本历史占用每个启用节点的本地磁盘，并非中央备份。
- HTTP 仅用于可信 LAN；公网管理和下载必须由外部 HTTPS reverse proxy 保护。
