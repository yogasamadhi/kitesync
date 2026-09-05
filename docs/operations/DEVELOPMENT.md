# 本地开发手册

## 环境和启动

需要 Bun 1.4+ 与 Go 1.26.x。日常开发不需要 Node.js、Docker 或数据库。

```bash
bun run bootstrap
bun run dev:all
```

`bootstrap` 只初始化固定版本的 Syncthing submodule、安装 workspace 依赖并构建本机 sidecar。
`dev:all` 在宿主机启动 contracts/API client watch、Vite 和 Node Service。开发状态位于仓库的
`.kitesync-dev/node`，管理页默认只监听 `127.0.0.1:3210`。

macOS x64/arm64 的 sidecar 使用 Xcode 工具链和 CGO 构建，最低系统版本为 macOS 13；Linux 与
Windows 目标继续关闭 CGO。`SYNCTHING_BUILD.json` 会记录目标的 CGO 策略和 macOS 最低版本，
旧的无 CGO macOS 缓存会被视为失效。macOS 上不要用 `CGO_ENABLED=0` 手工替换产物，否则系统
文件事件监视不可用，只能等待定时扫描。

Node Service 使用独立开发监督器：实际持有单实例锁的 `serve` 运行在子进程中；源码或 contracts
产物变化时，监督器会先等待旧进程停止、释放锁并结束 sidecar，再启动新一代服务。不要把
`serve` 直接包在 `bun --watch` 中，否则 Bun 的同 PID hard restart 会把上一代锁误认为另一个
实例。顶层启动器会等待 `/health` 成功后才报告节点就绪；`KITESYNC_UI_PORT` 同时控制 Node
Service 与 Vite 代理目标。

从全新 clone 开始时不要跳过 `bootstrap`：依赖安装使用 frozen lockfile，且 Node Service 启动前
必须已有与当前平台/架构匹配的 Syncthing sidecar。`bun run check` 会先生成 contracts、UI 和
API client 的 `dist` 再验证；`bun run build` 随后按 Web → Node Service 顺序构建，不依赖仓库中
残留的构建产物。

如果已经单独运行依赖 watch，可分别执行：

```bash
bun run predev
bun run --filter @kitesync/web dev
bun run --filter @kitesync/node-service dev
```

调试 Node Service：

```bash
bun run debug
```

如果曾使用包含旧 `bun --watch ... serve` 命令的版本，并看到“已在运行”但 3210 拒绝连接，请先
在原终端按一次 Ctrl+C，等待该开发进程组和 Syncthing sidecar 退出，再重新执行 `bun run.ts`。
不要在 owner PID 仍存活时手工删除 `node.lock`，也不要为处理启动错误运行 `dev:reset`，后者会
重置开发节点身份。

清除开发节点身份会导致所有 peers 需要重新配对，命令因此要求明确确认：

```bash
bun run dev:reset
```

该命令不会删除用户选择的同步目录或 Docker volumes。

## 双节点联调

为每个实例设置不同的 `KITESYNC_STATE_DIR` 和 UI 端口，在不同主机或隔离网络 namespace 中
运行。两台实体机测试更能覆盖 UDP discovery 和系统防火墙。

验证顺序：

1. 两端确认完整 Device ID/短指纹后配对；
2. 创建 folder 并选择 peer；接收端必须另选本地目录；
3. 验证新增、修改、删除、暂停、恢复和进程重启；
4. 关闭广播发现，使用完整 Device ID 与静态地址再次连接；
5. 验证 `sendreceive`、`sendonly`、`receiveonly` 和本机版本恢复。

不要为方便测试打开 global discovery、Relay、NAT/STUN 或 Syncthing REST 的 LAN 监听。
双节点集成测试最后一次写入不调用 scan API，必须依靠真实 watcher 自动同步；发布 CI 会在
macOS x64 和 arm64 原生 runner 重复该验证。

## 质量门禁

```bash
bun run check
bun run syncthing:build
bun run syncthing:build-verify
bun run build
bun run test:integration
bun run predev && bun run test:e2e
bun run licenses:check
```

可选容器只用于部署/镜像测试：

```bash
bun run docker:build
docker compose -f deploy/docker/docker-compose.yml config --quiet
```

## 配置约束

- 不加载 `.env`；开发覆盖值通过当前 shell 环境显式传入。
- `packages/{contracts,ui,api-client}` 的消费者使用 `dist`，修改后先 `bun run predev`。
- `apps/control-plane/migrations/*.sql` 是只读 legacy 记录，禁止修改，不属于运行时。
- migration 校验同时固定文件集合、manifest 与每个 SQL 的已发布 SHA-256；不能通过同时修改 SQL
  和 checksum manifest 绕过。
- Syncthing 必须由固定源码构建；不要引入下载的预编译二进制。
