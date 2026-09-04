# AGENTS.md

KiteSync 是 LAN-first P2P 文件同步应用（Bun Node Service + Syncthing data plane）。Bun monorepo
包含 `apps/*` 与 `packages/*`；文档和用户界面使用简体中文。

## 工具链

- workspace、开发和生产主程序均使用 Bun 1.4+；不要增加 Node.js 生产运行时。
- Syncthing v2.1.3 必须从 `vendor/syncthing/upstream` 的固定源码用 Go 1.26.x 构建。
- `bun run bootstrap` 初始化唯一的 Syncthing submodule、冻结安装依赖并构建本机 sidecar。
- 不自动加载 `.env`。Bun compile 必须设置 `autoloadDotenv: false` 和
  `autoloadBunfig: false`；不要引入 dotenv。
- 不使用数据库、Drizzle、`better-sqlite3`、`argon2` native addon、Electron 或 Tauri。

## 命令

- `bun run dev:all`：直接在宿主机启动 Node Service 和 Web，不要求 Docker。
- `bun run check`：Prettier、ESLint、边界/术语、Syncthing source、legacy migration checksum、
  许可证、typecheck 和 Vitest；提交前运行完整命令。
- `bun run test:integration`：本机双节点/HTTP 集成测试，不要求 Docker。
- `bun run predev && bun run test:e2e`：先构建 workspace dist，再运行 Web E2E。
- `bun run docker:up`：仅用于可选单容器 Linux 节点验证。

## 架构不变量

- `apps/node-service` 是唯一后端。Syncthing config 是 devices/folders 的唯一事实源；KiteSync
  `state.json` 只能保存 UI/auth/preferences，并必须原子写入。
- Syncthing REST/GUI 始终只监听 loopback。LAN UI 开关不得改变 REST 可达性。
- 允许 LAN discovery；禁止 global discovery、Relay、NAT/STUN、遥测和上游自动升级。
- 未知 device/folder 永不自动接受。远端 folder path 永不采用；接收者必须选择本机路径。
- 删除 folder 配置不删除文件，unpair 不声称删除 peer 副本。
- Web 只通过 `@kitesync/contracts`/API client 调用 Node Service，不直接调用 Syncthing。
- 文件 API 只读且限制在配置 folder 的 realpath 根内；禁止 symlink/junction 逃逸，并隐藏
  Syncthing metadata。
- 直接 LAN HTTP 必须显示未加密警告；public origin 必须显式为 HTTPS，转发头只信任配置代理。

## 打包

- 每个平台仅一个 Bun compiled `kitesync` 主程序，命令通过 subcommand 区分。
- Syncthing 是安装目录中先独立签名的真实 sidecar。compiled 代码从 `process.execPath`/平台
  resources 查找它，不能依赖 `import.meta.url` 或 cwd。
- Windows x64 使用 NSIS；macOS 13+ x64/arm64 使用真正 `.app` + Swift launcher；Linux
  x64/arm64 使用 deb/rpm 与 systemd。Docker 是可选的单 Node 镜像。
- 升级和默认卸载保留 KiteSync state、Syncthing home、Device ID 与同步目录。

## Legacy

`apps/control-plane/migrations/*.sql` 是不可变历史记录，不属于 workspace 或运行时。不得修改已有
SQL；`scripts/check-migration-checksums.mjs` 必须继续验证它们。除此之外不要恢复 Control Plane、
PostgreSQL、MinIO、Hub/Backup Controller、FileBrowser、Nginx 或 Helm。
