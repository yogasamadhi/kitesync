# 通用桌面软件架构基线

> 文档类型：Normative Baseline
>
> 架构版本：2.0
>
> 更新时间：2026-08-23
>
> 适用范围：Level 1 / Level 2 / Level 3 桌面架构
>
> 说明：本文件定义三个 Level 共享的不变量；各 Level 文档只描述增量复杂度。

---

# 1. Level 不是质量排名

Level 1、Level 2、Level 3 是复杂度与开放程度的选择，不是“普通、优秀、最好”的排名。

```text
Level 1 = 小型产品，模块化 Runtime，不使用 Plugin Kernel
Level 2 = 大型封闭产品，第一方 Internal Plugin Runtime
Level 3 = 大型开放平台，Level 2 + 隔离的第三方 Extension Host
```

选择高于真实需求的 Level 会增加生命周期、兼容性、安全和发布成本，同样属于架构错误。

---

# 2. 共同目标

所有 Level 都采用相同的宏观边界：

```text
Desktop / Web / CLI Client
        │
        │ Server Connection Manager
        │ REST / JSON / SSE / OpenAPI
        ▼
Independent Core Runtime
        │
        │ Versioned Host Capability API
        ▼
Desktop Host / Native Capability Providers
```

共同原则：

1. Client 不是 Runtime。
2. Electron Main 不是业务 Backend。
3. Renderer 不通过 Electron IPC 调用业务能力。
4. Core Runtime 不依赖 Electron 才能启动。
5. Runtime 是持久业务状态和工作流的事实源。
6. Desktop Host 只提供宿主、原生能力和进程监督。
7. Vendor Runtime 不拥有产品业务状态。

---

# 3. 进程与职责

## 3.1 Electron Main / Desktop Host

负责：

```text
Application lifecycle
Window / Menu / Tray
Updater / Deep Link
Native capability providers
Runtime / Engine / Extension Host supervision
```

不得负责：

```text
Domain workflow
Domain repository
Domain HTTP client orchestration
Business router
Persistent business state
```

## 3.2 Renderer

负责 UI、交互、展示状态和 Client cache。

不得直接获得：

```text
Electron business IPC
SQLite connection
Runtime internal context
Plugin server implementation
Vendor engine object
Credential plaintext after capture
Arbitrary absolute filesystem path
```

## 3.3 Core Runtime

Core Runtime 是独立 Node-compatible 服务进程，必须：

```text
不 import Electron
可 Headless 启动
可独立测试和重启
通过 HTTP 暴露正式业务 Contract
独立持有数据库、事件、任务和工作流状态
```

## 3.4 Vendor Runtime / Sidecar

外部 Agent、Python、FFmpeg 或其他 Vendor Runtime 可以保留原生协议：

```text
stdio / JSON-RPC / ACP / native API / HTTP
```

产品通过稳定 Adapter 使用它们，不为了形式统一强制套 HTTP。

---

# 4. 部署模式与认证

## 4.1 Desktop Local Mode

```text
bind = loopback
auth = per-start random token
origin = explicit allowlist
host capability = local, authenticated
```

Token 不应出现在日志、诊断或长期持久化中。Runtime 重启后必须更换 token 和 generation。

## 4.2 Headless Local Mode

可以由 CLI、launchd、systemd 或 Windows Service 启动，仍可只监听 loopback。

## 4.3 Remote Server Mode

Remote Server Mode 不是“把本地随机 token 暴露到局域网”。它必须单独定义：

```text
configurable bind policy
TLS or trusted reverse proxy
durable user / device authentication
CORS and Origin policy
rate limit and request limits
audit and session revocation
```

远程 Runtime 默认不能控制 Client 所在机器的 Desktop Host。若未来需要远程 Host Capability，必须建立由 Desktop 主动发起、可撤销、带用户确认的 capability session；在此之前返回 `CapabilityUnavailable`。

---

# 5. Server Connection Manager

所有 Client 必须通过统一连接层完成：

```text
discover
attach or spawn
authenticate
negotiate
ready
reconnect
disconnect
```

推荐连接状态：

```text
idle
discovering
attaching
authenticating
negotiating
ready
reconnecting
degraded
disconnected
incompatible
```

最低协议：

```text
GET /health                         # 无敏感发现信息
GET /api/{version}/version          # 已认证
GET /api/{version}/capabilities     # 已认证
GET /api/{version}/runtime          # 已认证、协议协商
```

连接层可以自动恢复：

```text
安全 GET
可重放事件流
显式声明幂等的请求
```

不得自动重试普通非幂等 mutation。调用方必须通过 `Idempotency-Key` 查询或确认未知提交结果。

Client 必须同时比较 bootstrap 和认证后 Runtime metadata 中的 runtime ID、generation、HTTP API 与 Plugin API；任一不一致都不得复用旧 cache、pending response 或事件。

---

# 6. HTTP Contract

正式 Client / Runtime 边界使用：

```text
REST
JSON
fetch-based SSE
OpenAPI
RFC 7807 Problem Details
ETag / If-Match
Idempotency-Key
Cursor Pagination
AbortSignal / timeout
Trace ID
```

要求：

- 每条长期路由有稳定且唯一的 `operationId`。
- 所有 2xx / 4xx / 5xx 响应拥有 Contract schema。
- Renderer 通过生成 Client 或受控 Domain Client 使用 API，不散落直接 `fetch`。
- SSE 必须定义 heartbeat、断线恢复、cursor replay、慢消费者和最终错误事件。
- Runtime 与 Host API 分别版本化并使用不同认证令牌。

---

# 7. Bootstrap

Preload 只允许暴露冻结的 Runtime bootstrap metadata，不暴露业务方法。

推荐：

```text
base URL
API version
runtime generation
one-time bootstrap nonce or short-lived token
application metadata
```

Desktop Local Mode 必须通过一次性内部通道用短期 nonce 换取 Runtime session metadata，避免把长期 token 放入可观察的进程命令行。该通道不得扩展为业务 IPC。

Runtime token 或 generation 改变后，Client 必须丢弃旧连接、旧事件和旧 pending response。

---

# 8. Desktop Capability

Runtime 通过版本化 Host API 使用桌面能力：

```text
File / Directory Grant
Export / Artifact Grant
Credential Reference
Window
Notification
Validated External URL
Updater status
Engine supervision
```

边界要求：

- Runtime、Renderer、日志和诊断不传播不必要的绝对路径。
- Renderer 只使用 `grantId`、`artifactRef`、`credentialRef` 等不透明引用。
- 凭据明文由 Host-owned capture 或等价安全输入流程获得并存储。
- Headless/Web 环境缺少桌面能力时返回结构化 `CapabilityUnavailable`。
- Provider HTTP 代理必须校验 scheme、DNS/重绑定、重定向、域名、私网策略、大小、类型、超时和 credential scope。

---

# 9. Runtime 兼容基线

Node.js 是默认兼容基线。Bun 只有在同一套 conformance suite 通过后才可声明支持。

```text
Node.js = MUST PASS
Bun     = declared support only after conformance passes
```

Runtime-specific API 必须收敛在 Adapter 中。Package Manager 与生产 Runtime 是两个独立决策；使用 Bun 安装依赖不代表必须用 Bun 启动 Runtime。

---

# 10. 数据与事件基线

Local-first Runtime 推荐 SQLite。无论是否使用插件，都必须明确：

```text
single authoritative writer
forward-only migrations
checksums and integrity checks
backup / recovery policy
transaction boundary
```

持久业务事件与业务状态在同一事务提交。事件至少定义：

```text
event id
global cursor
schema version
occurredAt
producer / owner
payload
```

Domain Event 与 Realtime Event 不共享模糊的 cursor 语义：

```text
Domain Event   = persistent, replayable, at-least-once
Realtime Event = ephemeral health / token / progress
```

只有当明确支持多个 Runtime 实例共享同一数据库时，才引入 consumer lease；不能为假设中的 HA 提前复杂化单 Runtime 模型。

---

# 11. Supervisor 与资源生命周期

每个被监督进程应具有统一状态：

```text
created → starting → ready → degraded → restarting → stopping → stopped
```

至少记录：

```text
generation
pid
startedAt
health
restartCount
lastExit
pendingRequestCount
configured / authenticated
```

规则：

- 使用系统分配端口并通过 ready handshake 返回实际端口。
- 重启使用 backoff、jitter、窗口期和总预算。
- 拒绝旧 generation 的迟到事件和响应。
- 崩溃立即结束相关 stream 和 pending request。
- shutdown 先停止接收新工作，再停止 Engine/Runtime，最后停止 Host。
- 所有 listener、timer、watcher、stream、worker、child process 都必须有 supervisor 或确定性 cleanup owner。

---

# 12. 测试与架构门禁

最低测试层次：

```text
unit
runtime integration
HTTP contract
headless conformance
fault injection
desktop E2E
package / upgrade smoke
```

必须覆盖：

```text
Runtime startup failure / crash / restart
SSE disconnect and replay
mutation timeout after server commit
duplicate Idempotency-Key
If-Match conflict
invalid token / origin
Host unavailable
effect or resource leak
migration failure and recovery
```

架构约束应通过受控 API、AST/依赖检查、生成物一致性和运行期 leak test 共同执行；不能假设简单文本搜索可以证明所有副作用都被追踪。

---

# 13. Level 选择

| 条件                                                       | 选择    |
| ---------------------------------------------------------- | ------- |
| 单一产品、小团队、官方功能、无动态组合                     | Level 1 |
| 多业务域、多团队、Profile、内部生命周期治理、不开放第三方  | Level 2 |
| 有真实第三方生态需求，并愿意承担权限、隔离、兼容和分发成本 | Level 3 |

升级时保留本基线，不改变 Client / Runtime / Host 的宏观边界，只增加必要的平台能力。
