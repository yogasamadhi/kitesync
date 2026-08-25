# 通用桌面软件架构：Level 3 大型开放项目版

> DramaIP 实现状态（2026-08-23）：本文定义的 Level 3 v1 已以每 revision 独立
> Extension Host process、QuickJS/WASM、Capability Broker、Ed25519 静态 Registry、
> Marketplace 与严格声明式 UI 落地。isolated interactive UI 和远程发布者后台仍为 future。

> 文档类型：Normative Level Profile
>
> 架构版本：2.0
>
> 更新时间：2026-08-23
>
> 适用对象：有真实第三方扩展需求并承担平台治理责任的大型桌面产品
>
> 共享基线：[DESKTOP_ARCHITECTURE_BASELINE.md](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> Level 2 基础：[DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md](./DESKTOP_ARCHITECTURE_LEVEL2_LARGE_CLOSED_FINAL.md)

---

# 1. 定位

Level 3 在 Level 2 的第一方 Internal Plugin Runtime 之外增加公共插件平台。

```text
Clients
   │ HTTP
   ▼
Core Runtime
├── Effective Core Graph
│   └── Built-in / trusted first-party plugins
│
├── Capability Broker
│
└── Extension Host boundary
        │
        ▼
   Effective Extension Graph
        └── Official isolated / third-party plugins
```

最大变化不是“多一个插件目录”，而是平台开始承担：

```text
public API compatibility
plugin identity
permission and consent
trust and signature
isolation and resource limits
data ownership and uninstall
update / rollback / quarantine
developer tooling and distribution
```

---

# 2. 前置条件

升级 Level 3 前，Level 2 必须已经稳定：

- Core Runtime 可以脱离 Electron 启动；
- Plugin Graph、Profile、迁移和 effect lifecycle 可靠；
- 路由和 UI Contribution 具有 owner；
- 数据所有权清晰；
- Runtime、Host、Engine 故障恢复有测试；
- Public Contract 与 Internal API 已物理分离。

如果这些基础仍处于过渡状态，应先完成 Level 2，不能用 Extension Host 掩盖 Core Runtime 的债务。

---

# 3. 逻辑 Graph 与进程放置

最终能力组合是一个逻辑 Product Graph，但必须显式分区：

```text
Product Profile
+ Installed Extension Set
+ Configuration
        │
        ▼
Effective Product Graph
├── Core Graph Revision
└── Extension Graph Revision
```

每个节点必须包含 placement：

```text
core
official-extension-host
third-party-extension-host
isolated-renderer
declarative-only
```

“属于 Effective Product Graph”不意味着代码可以进入同一进程。

Core/critical first-party plugin 不得依赖用户可禁用或卸载的第三方插件。第三方插件之间的依赖也不能提升其权限或信任等级。

---

# 4. Extension Host

Extension Host supervisor 是独立进程；第三方 bundle 在进程内独立 QuickJS/WASM runtime 中执行，负责：

```text
manifest loading
compatibility validation
plugin identity propagation
lifecycle and effect tracking
capability client
health / crash reporting
rate and resource accounting
reload / quarantine coordination
```

Core Runtime 与 Desktop Host 仍是权限的权威执行点。Extension Host 的本地检查只是第一层，不能信任第三方代码自行遵守 Permission。

Host bridge 使用 Electron/Node ABI；第三方 SDK 的可执行语义以 QuickJS/WASM conformance 为唯一基线，不承诺 Node builtin 兼容。

---

# 5. 隔离的真实含义

独立 Node 进程提供崩溃边界，但不自动等于安全沙箱。任意 Node 代码仍可能尝试访问文件、网络、环境变量、子进程和 native addon。

平台必须根据 Trust Level 组合使用：

```text
restricted module loader
no native addon by default
sanitized environment
working-directory isolation
filesystem / network policy
CPU / memory / request quotas
child-process prohibition
per-plugin or per-trust-group process
OS sandbox where available
```

需要强隔离的插件不能仅依赖同一 Extension Host 中的 JavaScript “fiber”。Fiber 是生命周期隔离，不是安全隔离。

---

# 6. Plugin 类型与 Trust

## 6.1 Built-in

随产品签名发布，可进入 Core Graph，并可标记 critical。

## 6.2 Official Isolated

官方维护但不需要 Core 权限，优先运行在 Extension Host，以验证公共 SDK 和隔离边界。

## 6.3 Verified Third-party

签名和发布者身份已验证，但仍按 least privilege 隔离。

## 6.4 Unverified / Development

默认更严格的权限、警告、资源限制和更新策略；生产环境可以完全禁止。

Trust 影响默认策略，不绕过显式 capability enforcement。

---

# 7. Manifest

最低 Manifest：

```json
{
  "id": "vendor.plugin",
  "version": "1.0.0",
  "pluginApi": "^1",
  "product": ">=3 <4",
  "entrypoint": "dist/index.js",
  "activation": "lazy",
  "reloadPolicy": "restart-extension-host",
  "permissions": [],
  "capabilities": [],
  "serverContributions": [],
  "uiContributions": []
}
```

安装和启用前验证：

```text
identity and version
content hash / signature
plugin API and product compatibility
dependencies
permission delta
entrypoints and module policy
contribution schemas
storage declaration
resource policy
```

Manifest 是声明，不是授权。最终 grant 由用户/管理员策略和 Capability Broker 决定。

---

# 8. Public Plugin SDK

第三方只能依赖：

```text
@product/plugin-api public exports
@product/contracts public exports
Web/ECMAScript standard APIs explicitly allowed by the host
```

禁止：

```text
Core Runtime internals
private Kernel / Cordis Context
Raw SQLite / Drizzle internals
Electron Main
Desktop Host implementation
Vendor engine native object
main Renderer React internals
```

Public API 必须区分：

```text
Public       = compatibility promise
Experimental = opt-in, no stable promise
Internal     = first-party implementation only
```

公共兼容承诺应从 Extension Host beta/conformance 开始明确计时，不能仅因为仓库里存在一个 package 就宣称生态已经稳定。

---

# 9. Capability 与 Permission

PluginContext 是 capability client，不是万能对象。

例如：

```text
projects.read / write
documents.read / write
assets.read / write
ai.invoke
network.request
storage.read / write
commands.register
events.subscribe
ui.contribute
notification.show
```

权限必须：

```text
declared
displayed
granted
revocable
enforced at authoritative boundary
audited without secrets
```

Capability 请求携带不可伪造的 plugin identity、grant revision、调用范围和 trace ID。权限收回后旧 grant 必须失效。

Credential 默认只通过受限 Provider/Network Capability 注入，第三方插件不直接获得明文 secret。

---

# 10. Lifecycle、Effect 与 Reload

Extension Host 使用与 Level 2 一致的 acquisition/effect 语义，但第三方 effect 只能作用于 Extension Host 或通过 capability 创建平台可撤销的远程资源。

每个已安装 revision 至少包含：

```text
plugin id
version
content hash
publisher / signature
manifest hash
granted permissions revision
```

更新流程：

```text
download to staging
→ integrity / signature
→ manifest and compatibility
→ permission review
→ dependency-aware stop plan
→ activate staged revision
→ health check
→ atomic switch
→ dispose old revision
```

失败时回滚上一可用 revision。重复崩溃进入：

```text
degraded → disabled → quarantined
```

插件可以声明：

```text
hot
restart-extension-host
restart-runtime
```

平台不承诺所有插件零停机热更新。`restart-runtime` 必须经过平台审核，不能成为第三方默认权限。

---

# 11. 第三方存储

第三方不得提交任意 SQL、修改 Core Table 或获得数据库连接。

优先提供：

```text
namespaced key/value or document storage
blob / artifact storage
declarative indexed schema capability
public domain capability
```

如果未来支持声明式表结构，Runtime 负责生成和执行安全迁移；插件不能直接执行 DDL/DML。

卸载必须显式选择：

```text
keep
export
delete after confirmation
```

插件更新失败不能破坏 Core 数据库的可启动性。

---

# 12. Server Contribution 与 OpenAPI

第三方 Server Contribution 通过 Runtime 中稳定的 namespace proxy 暴露，例如：

```text
/api/{version}/extensions/{pluginId}/...
```

第三方不能直接向 Core Hono/Express Router 安装 handler。Runtime 根据经过验证的声明将请求代理给 Extension Host，并在代理边界执行 identity、permission、limit、timeout 和 schema 校验。

必须区分：

```text
Platform OpenAPI
= stable official API
= generates @product/client

Instance Effective OpenAPI
= Platform OpenAPI
+ currently installed extension proxy contracts
= discovery / tooling / plugin-specific clients
```

通用生成 Client 不假设编译期知道用户未来安装的任意插件。

---

# 13. 第三方 UI

开放顺序：

```text
Command / Menu / Settings
→ Declarative Form / Table / Panel
→ Sandboxed Interactive UI
```

第三方 React/Vue bundle 不进入主 Renderer。

声明式 UI 由主 Renderer 使用平台组件渲染。任意交互代码使用独立隔离 Renderer、严格 sandbox iframe 或其他具有等价安全边界的容器，并通过 capability message protocol 与平台交互。

UI Contribution 仍受 plugin identity、permission、slot allowlist、content security policy 和资源限制约束。

---

# 14. 安装、分发与签名

顺序必须是：

```text
local development install
→ official isolated plugins
→ signed third-party packages
→ private registry
→ public registry / marketplace
```

Marketplace 是分发层，不是 Plugin Platform 本身。没有稳定 SDK、隔离、权限、升级和卸载之前不得建设 Marketplace。

权限扩大、发布者变化、签名变化或数据迁移变化时必须重新确认。

---

# 15. 故障与诊断

第三方插件失败只能影响自身或其 Extension Host trust group。

诊断至少显示：

```text
plugin identity / revision / trust
activation state
granted permission revision
active effects
resource usage
last crash / restart budget
capability failures
update / rollback state
```

日志和诊断不得包含 secret、绝对路径或未经脱敏的用户内容。

---

# 16. Architecture Gates 与测试

除 Level 2 门禁外增加：

```text
private API import
raw database / filesystem / network access
manifest and signature invalid
missing or overbroad permission
plugin identity mismatch
Core → third-party dependency
unsafe Renderer injection
storage namespace violation
extension route collision
permission escalation on update
resource limit and quarantine
```

必须提供恶意插件测试样本：

```text
filesystem escape
arbitrary network
environment read
child process / native addon
CPU / memory exhaustion
forged plugin identity
stale grant
crash loop
invalid migration declaration
unsafe UI message
```

---

# 17. MUST

1. MUST 遵守共享基线和 Level 2 全部约束。
2. MUST 将第三方代码放在独立 Extension Host/隔离 Renderer 中。
3. MUST 物理区分 Core Graph 与 Extension Graph。
4. MUST 提供版本化 Public Plugin SDK。
5. MUST 验证 Manifest、Compatibility、Identity、Permission 和 Trust。
6. MUST 在 Core/Host 权威边界执行 Capability Policy。
7. MUST 禁止第三方 Raw SQLite、Electron Main 和 Runtime internals。
8. MUST 为第三方数据定义安装、升级和卸载生命周期。
9. MUST 对第三方 UI 建立隔离边界。
10. MUST 支持 revision、rollback、disable 和 quarantine。
11. MUST 保持 Core critical 功能不依赖第三方插件。
12. MUST 将安全隔离与普通 lifecycle fiber 明确区分。

---

# 18. MUST NOT

1. MUST NOT 把内部 Plugin API 原样发布给第三方。
2. MUST NOT 因为代码位于独立 Node 进程就宣称已经安全沙箱化。
3. MUST NOT 让第三方代码进入 Core Runtime 或主 Renderer。
4. MUST NOT 给第三方万能 Context、任意 SQL、文件系统、网络或 child process。
5. MUST NOT 让 Bundle 绕过单插件 Permission、Trust 或 Compatibility。
6. MUST NOT 强迫所有插件支持 Hot Reload。
7. MUST NOT 先建设 Marketplace 再补安全模型。
8. MUST NOT 用用户安装插件改变官方 Product Profile。

---

# 19. 最终模型

```text
                    Clients
                       │ HTTP
                       ▼
                  Core Runtime
          ┌────────────┴────────────┐
          ▼                         ▼
  Effective Core Graph       Capability Broker
                                    │
                                    ▼
                              Extension Hosts
                                    │
                                    ▼
                         Effective Extension Graph
```

Level 3 的价值来自可治理、可撤销、可兼容的开放能力，而不是“可以执行第三方 JavaScript”本身。
