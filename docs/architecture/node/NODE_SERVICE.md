# Node Service

`apps/node-service` 是 KiteSync 唯一应用运行时。生产构建由 Bun 1.4 `compile + ESM + minify`
生成单个主程序，并明确关闭 `.env` 与 `bunfig.toml` 自动加载。Syncthing 仍是安装目录中的真实
sidecar，运行路径从 `process.execPath` 和平台 resource root 推导。

## 命令

- `kitesync` / `kitesync open`：确保后台实例存在，等待 `/health`，再打开系统浏览器；
- `kitesync serve`：持有状态锁、监督 Syncthing 并提供 UI/API；
- `kitesync setup`：为 headless 节点交互式设置密码、LAN 监听和 allowed origins；
- `kitesync service install|remove|status`：管理平台自启动；
- `kitesync identity`：输出完整 Device ID 和便于人工核对的短指纹。

## 模块边界

- `state`：原子 JSON、模式校验和单实例锁；
- `vault`：DPAPI、Keychain 或 Linux `0600` open secret；
- `syncthing`：sidecar 生命周期和 loopback REST client；
- `auth`：Argon2id、内存 session、CSRF、登录退避和一次性 token；
- `files`：folder-root 限定的分页浏览与 Range 下载；
- `server`：Host/Origin/代理边界和 `/api/v1` 路由；
- `main`：CLI、服务安装和浏览器唤醒。

Node Service 不导入数据库 driver、原生 npm addon或任何旧 Control Plane/Hub Controller 代码。
API DTO 来自 `@kitesync/contracts`；Web 不直接调用 Syncthing。

## 崩溃与升级

监督器对异常退出使用有上限的退避重启，并在主动关机时先停止接收 HTTP 修改，再优雅终止
Syncthing。安装器覆盖升级只替换程序和 sidecar；state、Syncthing home、证书、配置和同步目录
均留在平台数据目录中。卸载默认也保留这些数据。
