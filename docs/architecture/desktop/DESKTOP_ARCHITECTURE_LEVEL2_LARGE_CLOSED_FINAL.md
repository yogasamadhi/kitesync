# 通用桌面软件架构：Level 2 大型封闭项目版

> 文档类型：Normative Level Profile
>
> 架构版本：2.0
>
> 更新时间：2026-08-23
>
> 适用对象：多业务域、多团队、长期维护，但不加载第三方代码的专业桌面软件
>
> 共享基线：[DESKTOP_ARCHITECTURE_BASELINE.md](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 第三方插件：不支持

---

# 1. 定位

Level 2 在共享 C/S 基线上增加第一方 Internal Plugin Runtime，用于防止大型 Core Runtime 演化为 God Server。

```text
Clients
   │ HTTP
   ▼
Core Runtime
├── Runtime Gateway
├── Minimal Kernel
├── Effective Core Graph
└── First-party Plugins
```

插件在本 Level 中是内部软件工程机制，不是用户生态。用户不能安装任意代码，平台不承担公共 SDK、Permission、Trust、Marketplace 或第三方兼容承诺。

---

# 2. 适用条件

适合：

- 多个稳定 Bounded Context；
- 多团队并行维护；
- 需要 safe/test/e2e/enterprise 等产品形态；
- 路由、服务、事件、迁移和 UI Contribution 需要统一生命周期；
- 需要清晰的数据所有权；
- 所有运行代码均由同一官方信任域构建和签名。

不适合仅因为“插件听起来先进”而使用。业务规模不足时应选择 Level 1。

---

# 3. 组合模型

正式组合层级：

```text
Plugin
  ↓
Bundle
  ↓
Product Profile
  ↓
Effective Core Graph Revision
```

## 3.1 Plugin

插件粒度是：

```text
Bounded Context
或
Replaceable Platform Capability
```

插件可以贡献：

```text
stable contracts
typed services
HTTP routes
domain / realtime events
UI metadata
migrations
background work
diagnostics
```

普通 Entity、React Component、Utility 或单个按钮不是插件。

## 3.2 Bundle

Bundle 只负责：

```text
composition
dependency declaration
configuration defaults
product-oriented grouping
```

Bundle 不拥有表、迁移、业务状态、事件或领域逻辑。

## 3.3 Product Profile

Profile 只引用 Bundle 和少量显式配置，不复制长插件列表。

```text
studio
server
safe
test
e2e
enterprise
```

Profile 是官方发布的产品形态，不是用户扩展集合。

---

# 4. Minimal Kernel

Kernel 只负责平台机制：

```text
graph resolution and validation
lifecycle
effect tracking
typed services and capabilities
event infrastructure
migration coordination
contribution staging
diagnostics
```

Kernel 不负责具体业务域，也不应成为跨插件万能 Service Locator。

Cordis 或类似 microkernel 可以作为私有 composition root，但属于实现选择，不是架构公共契约。插件不得依赖其私有 Context，未来替换 Kernel 实现不应破坏插件 Contract。

---

# 5. Plugin Contract 与依赖

插件禁止导入其他插件实现。

允许：

```text
versioned stable contract
typed service
capability
public domain event
explicit read-only projection
```

依赖图必须是 DAG。启动前验证：

```text
unknown plugin
missing dependency
cycle
version conflict
duplicate contribution
missing required capability
```

业务跨域协作优先通过 Service 或 Event。确需跨域查询时，只能通过 owner 提供的只读 projection contract，不能直接访问其他插件 Repository。

---

# 6. Typed Services

Service Registry 应使用有约束的 API：

```ts
ctx.services.provide<T>(contract, implementation);
ctx.services.require<T>(contract);
ctx.services.optional<T>(contract);
```

Contract 至少描述：

```text
id
version
capabilities
input / output type
error type
owner
```

`require()` 缺失在 Graph 激活阶段失败；`optional()` 只用于真正可降级或环境相关能力。禁止字符串随意取任意对象的全局 Service Locator。

---

# 7. Graph Revision 与原子激活

每次有效组合必须拥有不可混淆的 revision：

```text
profile
bundle versions
plugin versions
contract versions
configuration fingerprint
```

标准启动流程：

```text
Resolve
→ Validate
→ Migrate
→ Stage Routes / Services / Events / UI
→ Activate Plugins
→ Validate Effective OpenAPI and Graph
→ Atomic Publish Revision
→ Ready
```

任何阶段失败都必须撤销本次 staging，不得暴露半激活 Runtime。

Level 2 默认允许采用更简单、更安全的生产策略：

```text
first-party graph is immutable after boot
profile change requires Runtime restart
```

只有存在真实需求时才开放运行期 reload。

---

# 8. Reversible Effects

每个长期副作用必须有 owner、plugin version、graph revision 和 label。

推荐 acquisition API：

```ts
await ctx.effect('route:workspace.projects', () => ctx.http.register(route));

await ctx.effect('timer:automation.scheduler', () => {
  const timer = setInterval(tick, interval);
  return () => clearInterval(timer);
});
```

平台负责 acquire 和登记，避免插件先创建资源、后登记 cleanup 时发生泄漏。

要求：

- activation 失败清理当前 revision；
- 同一 owner 逆序释放；
- unload/restart 清理所有长期资源；
- diagnostics 可列出活跃 effect；
- 测试结束 effect 数量归零；
- 禁止未登记 timer、listener、watcher、stream、worker 和 child process。

---

# 9. HTTP Route 生命周期

从 Registry 删除 route metadata 不等于从底层 Router 删除已安装 handler。

安全策略二选一：

## 9.1 Immutable Router

生产 Graph 启动后不可动态 unload，Profile 切换通过 Runtime restart 完成。

## 9.2 Atomic Router Swap

```text
Active Router A
     │
build and validate Router B
     │
atomic swap
     ▼
dispose Router A effects
```

不得依赖修改 Hono、Express 或其他框架的私有路由表实现卸载。

---

# 10. 数据所有权与迁移

每张业务表必须有唯一插件 owner。插件导出：

```text
migrations
owned tables / indexes
event schemas
retention policy
read-only projections
```

迁移账本至少记录：

```text
plugin id
migration id
plugin version
dependency
checksum
executedAt
duration / result
```

迁移 forward-only，并支持 preflight、backup、integrity check、timeout 和失败诊断。

业务状态和 Domain Event 在同一事务提交。commit 后唤醒 durable dispatcher；消费者使用 checkpoint、幂等 handler、retry/backoff 和 dead-letter/degraded diagnostics。

---

# 11. UI Contribution

Runtime 只返回启用的 Contribution ID 和 metadata。Renderer 使用构建期生成、随应用签名的 loader registry：

```text
Runtime enabled IDs
       ∩
signed builtin loader registry
       ↓
actual routes / panels / commands
```

未知 ID 不执行任何代码。

UI Shell 只负责：

```text
bootstrap
runtime connection
global navigation host
route outlet
error boundary
contribution registry
```

具体页面按领域拆分和 lazy load。Level 2 没有第三方 UI Sandbox。

---

# 12. Architecture Catalog 与门禁

建议生成以下可审计快照：

```text
table owners
route and operation owners
event owners
UI contribution owners
service contracts
capability contracts
```

这些文件应由 Plugin Descriptor、Migration、OpenAPI 和 Contribution 源生成并在 CI 检查漂移，不能成为第二套手写真相源。

门禁至少拒绝：

```text
cross-plugin implementation import
unowned table / route / event
duplicate operationId
Renderer business IPC / direct fetch / server implementation import
Electron Main domain implementation import
untracked long-lived resource
profile / bundle / graph invalid
migration / OpenAPI drift
```

---

# 13. 测试

除共享基线外增加：

```text
plugin unit / integration
dependency graph
profile and bundle
activation rollback
effect leak
route revision
migration ownership
domain event replay
optional capability degradation
effective OpenAPI
UI contribution resolution
```

故障测试必须覆盖 critical/optional plugin 失败、迁移 checksum 错误、Graph staging 失败和 Runtime 重启。

---

# 14. MUST

1. MUST 遵守共享架构基线。
2. MUST 使用第一方 Internal Plugin Kernel 组织复杂 Runtime。
3. MUST 保持 Kernel 不包含领域业务。
4. MUST 使用 Plugin → Bundle → Profile → Graph Revision。
5. MUST 验证插件依赖 DAG。
6. MUST 禁止跨插件实现 import。
7. MUST 跟踪并逆序释放全部长期 effect。
8. MUST 原子发布有效 Graph，不能暴露半激活状态。
9. MUST 为表、迁移、路由和事件声明唯一 owner。
10. MUST 区分 Domain Event 与 Realtime Event。
11. MUST 使用受签名的内置 UI loader registry。
12. MUST 保持所有运行代码处于官方信任域。

---

# 15. MUST NOT

1. MUST NOT 加载第三方代码。
2. MUST NOT 为假设中的生态提前建设 Permission、Trust 或 Marketplace。
3. MUST NOT 让 Kernel 变成 God Server。
4. MUST NOT Plugin Everything。
5. MUST NOT 让 Bundle 拥有业务状态。
6. MUST NOT 给插件万能 Context、Raw SQLite 或其他插件 Repository。
7. MUST NOT 在没有真实需求时承诺生产 HMR。
8. MUST NOT 通过修改 HTTP 框架私有状态伪造路由卸载。

---

# 16. 升级到 Level 3 的触发条件

只有出现真实第三方生态需求，并愿意承担以下长期成本时升级：

```text
Public SDK compatibility
manifest and identity
permission UX and enforcement
process / OS isolation
plugin data lifecycle
update and rollback
malicious plugin testing
distribution and signing
```

升级增加独立 Extension Host；第三方代码不得因此进入 Level 2 的 Core Runtime 和主 Renderer。

---

# 17. 最终模型

```text
Clients
   │ HTTP
   ▼
Core Runtime
├── Minimal Kernel
└── Effective Core Graph
    └── First-party Plugins
```

Level 2 的目标是让大型封闭产品拥有可靠的内部组合、生命周期和所有权，而不是提前模拟一个尚不存在的插件市场。
