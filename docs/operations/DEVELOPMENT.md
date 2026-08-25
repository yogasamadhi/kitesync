# 本地开发手册

## 拓扑与边界

应用进程运行在本机：Control Plane `127.0.0.1:3000`、Web `127.0.0.1:5173`、Electron 和 Desktop Runtime。Docker Compose 只运行 PostgreSQL 17、MinIO、Syncthing Hub 与 Hub Agent。

Hub Agent 使用 `network_mode: service:syncthing-hub` 共享 Hub 网络命名空间。Syncthing REST 始终只监听 `127.0.0.1:8384`，宿主机无法直接访问；Agent 的 mTLS Contract 发布为 `127.0.0.1:9443`。Syncthing 数据端口只发布到宿主机 loopback 的 TCP/UDP 22000。

## 启动

```bash
bun --version
bun run bootstrap
bun run dev:all
```

`dev:all` 调用根目录 `run.ts`。启动器执行版本与端口检查、启动 Compose、执行数据库迁移、运行宿主机 watch 进程并探测健康端点。Ctrl+C 会终止整个子进程树；仅当 Compose 是本次启动的，启动器才会停止容器，named volumes 始终保留。

空数据库首次启动时，`run.ts` 自动创建开发管理员，并在 Electron 登录页填入用户名 `admin` 和密码 `kitesync-development`。已有管理员不会被覆盖；如果此前使用了其他凭据，请通过环境变量提供相同值或执行明确确认的 `bun run dev:reset` 重建开发数据。

调试选项：

```bash
bun run debug              # Node 子进程使用随机 Inspector 端口
bun run run.ts --headless  # 不启动 Electron
bun run run.ts --no-deps   # 不管理 Compose
bun run run.ts --keep-deps # 退出后保留 Compose 容器
```

如需分开观察日志：

```bash
bun run dev:deps
bun run dev
bun run dev:logs
```

Compose 使用 `postgres-data`、`minio-data`、`hub-state`、`hub-data` 和 `hub-agent-state` named volumes。`bun run dev:stop` 保留这些卷；只有 `bun run dev:reset` 在输入明确确认后删除它们。

## 环境变量

默认值仅用于本机开发。需要覆盖时复制 `.env.example` 并由 shell/进程管理器加载。证书由 `bun run dev:certs` 写入 `deploy/compose/certs`，该目录不提交版本库。

开发登录信息可通过 `KITESYNC_DEV_USERNAME`、`KITESYNC_DEV_PASSWORD`（至少 12 个字符）和 `KITESYNC_DEV_DISPLAY_NAME` 覆盖。这些变量仅供 `run.ts` 初始化和 Electron 开发表单使用，不进入正式打包客户端。

桌面侧下载的 Syncthing 位于 `vendor/syncthing/bin/<platform>-<arch>`。可用 `KITESYNC_SYNCTHING_PLATFORM` 和 `KITESYNC_SYNCTHING_ARCH` 为发布目标预取；脚本会验证官方签名、SHA-256 及二进制实际版本。

## 验证顺序

```bash
bun run check
bun run build
bun run test:integration
bun run test:e2e
bun run licenses:check
docker compose -f deploy/compose/docker-compose.yml config --quiet
helm lint deploy/helm/kitesync \
  --set backup.enabled=false \
  --set controlPlane.bootstrapToken=test-bootstrap \
  --set controlPlane.cookieSecret=test-cookie-secret-32-characters \
  --set hub.apiKey=test-api-key \
  --set postgresql.password=test-postgres-password
```

PR 不启动 Kind。nightly、RC 与 release workflow 才渲染或部署 Helm，以保持本地反馈速度。

## 故障处理

- 9443 不可用：检查 Hub health、Agent 日志和开发证书是否已生成。
- Hub Device ID 改变：确认 `hub-state` 卷未被删除；普通容器重建不得改变 identity。
- 桌面目录不可用：Runtime 返回 `StorageUnavailable` 并保持 binding，不将移动磁盘缺失解释成文件删除。
- Control Plane 离线：已配置的 Syncthing 数据面继续工作；恢复后 Runtime 和 Worker 按 revision 追平。
