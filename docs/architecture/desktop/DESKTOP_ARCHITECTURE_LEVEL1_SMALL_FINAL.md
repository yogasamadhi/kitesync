# 通用桌面软件架构：Level 1 小型项目版

> 文档类型：Normative Level Profile
>
> 架构版本：2.0
>
> 更新时间：2026-08-23
>
> 适用对象：目标单一、边界清晰、小团队维护的桌面产品
>
> 共享基线：[DESKTOP_ARCHITECTURE_BASELINE.md](./DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 插件系统：不使用

---

# 1. 定位

Level 1 的目标是在不引入插件平台成本的前提下，建立正确的 Client / Runtime / Host 边界。

```text
Desktop / Web / CLI Client
        │ HTTP
        ▼
Core Runtime
├── HTTP API
├── Application Services
├── Domain Modules
├── Persistence
├── Background Tasks
└── External Adapters
```

Level 1 不是“把所有代码放进 Electron”，也不是简化掉独立 Runtime。它只是不引入 Plugin Kernel、Bundle、Profile、动态 Graph 和第三方扩展。

---

# 2. 适用条件

适合：

- 单人或小团队；
- 单一产品目标；
- 功能全部由官方维护；
- 业务模块数量稳定；
- 不需要用户安装扩展；
- 不需要多个产品 Profile；
- 不需要业务模块独立启停或热更新。

如果产品只是 MVP，但已经确定会发展为多业务域平台，可以仍从 Level 1 起步；升级路径必须保留共享基线中的 HTTP C/S 边界。

---

# 3. Runtime 内部结构

推荐使用普通模块和显式依赖注入：

```text
runtime/
├── bootstrap/
├── http/
├── application/
├── domain/
├── repositories/
├── tasks/
└── adapters/
```

## 3.1 Application Layer

负责：

```text
Use Case
Workflow
Transaction Boundary
Authorization decision
Idempotency orchestration
```

## 3.2 Domain Layer

负责：

```text
Entity
Value Object
Business Rule
Domain Service
Domain Event definition
```

## 3.3 Adapter Layer

负责 SQLite、文件、Credential Provider、AI Provider、导出和其他具体实现。

Domain 和 Application 不直接依赖 Electron、HTTP 框架或具体数据库实现。

---

# 4. 模块边界

Level 1 不使用插件，但仍要防止形成 God Module。

推荐按业务能力拆分模块：

```text
projects
documents
tasks
providers
exports
```

模块通过明确接口协作，不通过全局单例、跨目录内部 import 或共享可变状态耦合。

当接口注册、路由、监听器和后台任务需要独立生命周期时，应考虑升级到 Level 2，而不是在 Level 1 中自行发明半套 Plugin Kernel。

---

# 5. 资源生命周期

Level 1 不要求 Plugin Reversible Effect System，但所有长期资源必须由 Application Supervisor 或明确 owner 管理：

```text
HTTP listener
SSE subscription
timer
watcher
worker
child process
database handle
```

初始化接口应成对提供：

```text
start / stop
open / close
subscribe / unsubscribe
acquire / release
```

测试 teardown 后长期资源数量必须归零。

---

# 6. 数据、任务与事件

Runtime 是业务事实源。Renderer state 只能作为 UI state 或 Client cache。

长任务可以使用：

```text
queued → running → succeeded | failed | canceled
```

当任务需要复杂审批、恢复、补偿、跨模块持久工作流时，应显式建立 Workflow/Run 模型，不能把业务真相寄存在 Worker 或 Vendor Runtime 中。

如果使用 Domain Event，遵守共享基线中的事务提交、持久/实时区分和幂等消费规则；不必为了小型产品提前建设复杂 Event Platform。

---

# 7. 推荐仓库结构

```text
project/
├── apps/
│   └── desktop/
├── packages/
│   ├── runtime/
│   ├── contracts/
│   ├── client/
│   ├── desktop-host/
│   └── ui/
├── docs/
├── scripts/
└── tests/
```

目录只是参考，重要的是依赖方向和进程边界，不要求为了匹配示例机械拆包。

---

# 8. MUST

1. MUST 遵守共享架构基线。
2. MUST 保持 Runtime 独立于 Electron。
3. MUST 使用 HTTP 作为 Client / Runtime 业务边界。
4. MUST 保持 Runtime 可 Headless 启动和独立测试。
5. MUST 让 Runtime 成为持久业务事实源。
6. MUST 为所有长期资源提供确定性 cleanup。
7. MUST 使用明确模块接口和单向依赖。
8. MUST 通过 Adapter 隔离数据库、Host 和 Vendor Runtime。

---

# 9. SHOULD

1. SHOULD 使用 REST + JSON + SSE + OpenAPI。
2. SHOULD 使用生成 Client SDK。
3. SHOULD 在 Electron 中使用 `utilityProcess` 承载 Node Runtime。
4. SHOULD 使用 SQLite 作为 Local-first 默认数据库。
5. SHOULD 使用系统分配端口和统一 Server Connection Manager。
6. SHOULD 保留未来 Web / CLI Client 的可能性。

---

# 10. MUST NOT

1. MUST NOT 引入 Plugin Kernel、Bundle、Profile 或 Marketplace，除非真实复杂度已经出现。
2. MUST NOT 使用 Electron IPC 承载业务 API。
3. MUST NOT 把 Electron Main 做成 Backend。
4. MUST NOT 让 Renderer 直接访问数据库、Provider SDK 或任意文件系统。
5. MUST NOT 把小型应用拆成大量 localhost 微服务。
6. MUST NOT 为假设中的远程或多实例场景提前引入分布式协调。

---

# 11. 升级到 Level 2 的触发条件

出现以下多个信号时升级：

```text
业务域快速增长
多人或多团队长期并行
模块需要独立生命周期
路由、服务、事件和任务注册难以追踪
需要 safe / test / enterprise 等 Profile
需要按产品能力组合功能
跨模块数据所有权开始模糊
```

升级后增加：

```text
Internal Plugin Kernel
Plugin → Bundle → Profile
Typed Services
Reversible Effects
Plugin-owned Data / Migration / Events
UI Contributions
```

不改变共享基线中的进程和 HTTP 边界。

---

# 12. 最终模型

```text
Clients
   │ HTTP
   ▼
Independent Runtime
   │
Application / Domain Modules
   │
Adapters / Database / Tasks
```

Level 1 的优秀不是功能少，而是以最小必要机制维持清晰、可测试、可演进的边界。
