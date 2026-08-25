# KiteSync v1.0

KiteSync 是面向单组织局域网的服务器中心型文件同步产品。桌面客户端仅连接一个长期在线的 Syncthing Hub；Control Plane 管理账户、设备、同步空间、策略、审计和调和，服务器保存文件明文副本。

## 本地开发

要求：Bun 1.4、Node.js 24、Docker Desktop，以及可用的 3000、5173、5432、9000、9001、9443、22000 端口。Bun 负责 workspace、依赖、脚本和开发构建；Node.js 仍是 Control Plane、Hub Agent 与 Desktop Runtime 的生产运行时。

```bash
bun run bootstrap
bun run dev:all
```

`bootstrap` 会安装依赖、生成仅用于 localhost 的开发 CA，并从官方发布校验 PGP 签名、SHA-256 和版本后下载 Syncthing v2.1.3。`dev:all` 在 Docker Desktop 中运行 PostgreSQL、MinIO、Hub 和 Hub Agent，在宿主机热重载 Control Plane、Web、Desktop Runtime 与 Electron。

`dev:all` 由根目录的 `run.ts` 统一编排：它会检查 Bun、Node.js、Docker Desktop 和应用端口，等待服务健康，并在 Ctrl+C 后停止本次启动的容器但保留开发卷。若 Compose 在启动前已经运行，则不会被脚本误停。

`run.ts` 会在空数据库中自动创建开发管理员，并把登录信息填入 Electron 登录页：用户名 `admin`，密码 `kitesync-development`。可通过 `KITESYNC_DEV_USERNAME`、`KITESYNC_DEV_PASSWORD` 和 `KITESYNC_DEV_DISPLAY_NAME` 覆盖；如果数据库已经初始化，启动器不会修改既有管理员或密码。开发凭据不可用于生产。

常用命令：

```bash
bun run dev:deps          # 仅启动 Compose 依赖并执行迁移
bun run dev               # 仅启动宿主机应用
bun run debug             # 全量启动，并为 Node 子进程开放随机 Inspector 端口
bun run run.ts --headless # 不启动 Electron，适合终端/API 调试
bun run run.ts --no-deps  # 复用已经由其他方式管理的基础依赖
bun run run.ts --keep-deps # 退出应用后让 Compose 继续运行
bun run dev:stop          # 停止容器，保留 named volumes
bun run dev:reset         # 交互确认后删除本地开发数据
bun run check             # 格式、lint、边界、迁移、类型和单元测试
bun run test:integration  # PostgreSQL 17 集成测试
bun run test:e2e          # Web 端到端测试
bun run licenses:check    # 许可证门禁
```

## 组件

- `apps/control-plane`：Fastify、TypeBox、Drizzle 与 PostgreSQL 业务事实源和调和 Worker。
- `apps/web`：React、Vite、TanStack Router/Query 管理控制台。
- `apps/desktop` 与 `apps/desktop-runtime`：Electron Host/Renderer、独立本地 Runtime、凭据库、Directory Grant 和 Syncthing 进程监督。
- `services/hub-agent`：通过 mTLS 暴露 Desired State Contract，是唯一持有 Hub Syncthing API Key 的进程。
- `services/backup-controller`：一致性 CSI 快照、Restic S3 上传、保留与 Control Plane 回调。
- `deploy/compose`：只用于开发的基础依赖。
- `deploy/helm/kitesync`：生产 K8s Chart；支持内置或外部 PostgreSQL。

详细设计见 [服务器中心型架构](docs/architecture/KITESYNC_SERVER_CENTRIC_ARCHITECTURE.md)，操作说明见 [本地开发](docs/operations/DEVELOPMENT.md)、[生产运行手册](docs/operations/PRODUCTION_RUNBOOK.md)、[备份恢复](docs/operations/BACKUP_RESTORE.md) 和 [发布手册](docs/operations/RELEASE.md)。

## 安全与范围

产品禁用 Syncthing 自动接受、local/global discovery、公共 relay、NAT traversal 和自更新。客户端配置中只允许 Hub 设备，设备身份必须用 Ed25519 产品密钥证明并由 Hub 观察到真实 Syncthing 证书连接后绑定。Web 使用 HttpOnly Cookie、CSRF 与 Argon2id；桌面使用系统凭据库、轮换 refresh token 和内存 access token。

v1.0 不支持公网、客户端 P2P、原生 Syncthing 客户端、安全只读、多 Hub 调度、active-active、移动端、内容预览或全文搜索。

## GA 外部验收门

源码和自动化已经提供生产交付路径，但正式 GA 仍必须在目标基础设施执行：三平台代码签名与 macOS 公证、真实 CSI/S3 空集群恢复演练、目标 CA/cert-manager 验证、30 台设备 7 天 soak，以及 100 用户/300 设备/100 空间容量测试。这些步骤需要组织的集群、证书和离线发布密钥，不能由本地开发环境代替。
