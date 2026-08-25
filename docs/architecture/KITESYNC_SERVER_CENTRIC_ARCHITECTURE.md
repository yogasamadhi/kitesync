# KiteSync 服务器中心型架构设计

> 文档类型：v1.0 Implementation Baseline
>
> 部署模型：Kubernetes Server + Desktop Clients
>
> 同步拓扑：Hub-and-Spoke
>
> 版本：1.0
>
> 更新时间：2026-08-24
>
> 桌面共享基线：[DESKTOP_ARCHITECTURE_BASELINE.md](./desktop/DESKTOP_ARCHITECTURE_BASELINE.md)
>
> 桌面 Level Profile：[DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md](./desktop/DESKTOP_ARCHITECTURE_LEVEL1_SMALL_FINAL.md)

---

# 1. 架构结论

KiteSync 改为服务器中心型产品。

Kubernetes 中部署长期在线的 KiteSync Control Plane 和 Syncthing Hub。每个桌面客户端只与被分配的 Hub 同步，不与其他客户端直接建立 Syncthing 文件同步关系。

    Desktop A ─┐
    Desktop B ─┼── Syncthing Hub on Kubernetes ── Persistent Volume
    Desktop C ─┘

控制关系：

    Desktop Clients
           │
           │ HTTPS / JSON / SSE
           ▼
    KiteSync Control Plane
           │
           ├── PostgreSQL
           ├── Hub Reconciler
           └── Audit / Policy / Device Management
                        │
                        │ internal mTLS management contract
                        ▼
                    Hub Agent
                        │ loopback REST
                        ▼
                  Syncthing Hub

文件关系：

    Desktop Syncthing
           │
           │ Syncthing encrypted transport
           ▼
    Kubernetes Syncthing Hub
           │
           ▼
    Server Persistent Volume

核心决策：

1. Control Plane 是组织级业务状态和同步拓扑的事实源。
2. Syncthing Hub 是服务器文件副本和文件同步数据面的中心节点。
3. 桌面 Local Runtime 只持有机器本地状态、策略缓存和执行状态。
4. 每个客户端 Syncthing 只配置 Hub 为远端设备。
5. 客户端之间不使用 Syncthing local discovery、global discovery、relay 或 P2P 直连。
6. Hub 持久保存普通文件内容，因此默认情况下 Kubernetes 管理员可以读取文件。
7. Control Plane 与桌面端均保持正式 HTTP Contract，不使用 Electron 业务 IPC。
8. 桌面端继续采用 Level 1，不引入插件系统。
9. v1.0 使用一个固定 Hub；模型预留 `hubId`，但不实现多 Hub 调度、分片迁移或共享状态多副本。

---

# 2. 为什么选择服务器模型

服务器模型解决以下核心问题：

- 发送设备上传完成后可以离线；
- 接收设备可以在之后任意时间同步；
- 所有设备、成员关系和同步空间集中管理；
- 设备吊销只需在 Hub 侧立即生效；
- 服务器拥有稳定文件副本，可以执行历史版本和灾难备份；
- 管理员可以查看容量、健康、审计和同步状态；
- 客户端不需要建立全互信 Mesh；
- 不依赖局域网广播能否跨 VLAN 或 Wi-Fi 隔离区工作。

主要代价：

- 每次跨设备同步需要一次上传和一次下载；
- Hub 的网络、存储和 IOPS 成为共享资源；
- Hub 不可用时所有客户端停止交换新文件；
- 服务器默认可以读取文件明文；
- 需要维护 PostgreSQL、PVC、备份、监控和升级；
- 大规模时需要显式分片。

---

# 3. 产品目标与非目标

## 3.1 v1.0 目标

正式容量目标为 100 用户、300 注册设备、100 同步空间、10 TiB，并至少验证 100 个并发 Syncthing 连接。

- 使用账户或组织邀请注册桌面设备；
- 由管理员或用户创建同步空间；
- 将多个设备加入同步空间；
- 每台设备为同步空间选择本地目录；
- 所有文件通过服务器 Hub 上传和分发；
- 发送设备离线后，其他设备仍能从 Hub 获取文件；
- 支持暂停、恢复、移除设备和同步空间；
- 集中展示设备、空间、容量、同步和错误状态；
- 支持服务器文件历史与 PVC 备份；
- 支持 Windows、macOS 和 Linux 桌面客户端；
- 整套系统只需要访问局域网中的 K8s；
- Control Plane 临时不可用时，已经配置完成的 Syncthing 同步可以继续。

## 3.2 v1.0 非目标

- 不进行客户端之间的 P2P 文件同步；
- 不使用公共 Syncthing discovery 或 relay；
- 不支持公网访问；
- 不实现在线占位文件或虚拟磁盘；
- 不实现文档内容级实时协作；
- 不实现自动内容合并；
- 不实现第三方插件平台；
- 不实现跨 Kubernetes 集群复制；
- 不实现 Hub active-active；
- 不提供服务器不可读的端到端加密承诺；
- 不支持移动端后台同步；
- 不把 Syncthing Web GUI 暴露给最终用户。

---

# 4. 系统边界与进程拓扑

## 4.1 Kubernetes Server

    Kubernetes Cluster
    ├── Control Plane API
    ├── Control Plane Worker / Reconciler
    ├── PostgreSQL
    ├── Syncthing Hub StatefulSet
    │   ├── Hub Agent sidecar
    │   └── Syncthing container
    │       ├── Syncthing identity and config
    │       ├── Syncthing index
    │       ├── synchronized files
    │       └── file versions
    ├── API Ingress / Internal Load Balancer
    ├── Hub Management Service
    ├── Syncthing Data Service
    ├── Backup Jobs
    └── Metrics / Logs / Alerts

## 4.2 Desktop Client

    Electron Desktop Host
    ├── Renderer
    ├── Independent Local Runtime
    └── Syncthing Client Engine

业务调用：

    Renderer
        → Local Runtime REST / SSE
        → Control Plane HTTPS / SSE

桌面能力调用：

    Local Runtime
        → Versioned Host Capability API
        → Electron Desktop Host

文件传输：

    Desktop Syncthing
        → explicit Hub address
        → Kubernetes Syncthing Hub

禁止的数据路径：

    Desktop A Syncthing  ╳  Desktop B Syncthing

---

# 5. 组件职责

## 5.1 Control Plane API

负责：

- 用户、组织和会话；
- 设备注册、批准、暂停和吊销；
- 产品级设备身份与 Syncthing Device ID 绑定；
- 同步空间及成员关系；
- Hub 分配；
- 配置 revision 和策略下发；
- 设备心跳和兼容性；
- Idempotency-Key；
- ETag / If-Match；
- 审计事件；
- 管理后台 API；
- 桌面客户端事件流。

不得负责：

- 直接读写桌面本地目录；
- 持有桌面 Directory Grant 真实路径；
- 通过远程调用控制 Electron 窗口；
- 代理全部文件内容；
- 把 Syncthing 原始 REST API 暴露给客户端。

## 5.2 Control Plane Worker / Reconciler

负责：

- 通过版本化 Hub Agent Contract 将 PostgreSQL Desired State 投影到 Hub；
- 创建、更新、暂停和移除 Hub folder；
- 创建和移除 Hub device；
- 维护 folder 与 device 关系；
- 读取 Hub Agent 返回的 Observed State；
- 更新 provisioning、ready、degraded 等状态；
- 处理重试、超时和未知提交结果；
- 生成持久审计事件；
- 执行配额和容量检查。

v1.0 Worker 与 API 位于同一应用代码库，但任务生命周期、资源 owner 和关闭顺序保持独立。

## 5.3 PostgreSQL

是组织级业务事实源，保存：

- organization；
- user；
- product device；
- Syncthing identity binding；
- sync space；
- membership；
- hub assignment；
- desired revision；
- provisioning operation；
- idempotency record；
- audit event；
- policy；
- quota；
- server-side status projection。

PostgreSQL 不保存文件正文和桌面绝对路径。

## 5.4 Syncthing Hub

负责：

- 维护服务器 Syncthing identity；
- 接收桌面客户端上传；
- 将服务器文件副本发送给其他客户端；
- 文件扫描、块索引和同步协议；
- 服务器端文件版本；
- 连接和传输状态；
- 文件冲突副本；
- 远端变更的落盘。

不得负责：

- 用户登录和组织权限；
- 产品级成员审批；
- 管理后台；
- API session；
- 审计事实；
- 业务幂等性；
- 自动创建未经 Control Plane 批准的设备或文件夹。

Hub 的配置是 Control Plane Desired State 的执行投影，不是组织级业务事实源。

## 5.5 Hub Agent

Hub Agent 与 Syncthing 容器运行在同一个 Hub Pod 中，共享 Pod network namespace。

负责：

- 通过 loopback 调用 Syncthing REST 和 Event API；
- 隔离 Syncthing API Key；
- 向 Control Plane 提供版本化、最小化的 Hub Management Contract；
- 将 Syncthing DTO 转换为稳定的 Hub DTO；
- 返回 Hub generation、capabilities、snapshot 和 health；
- 执行配置调和命令；
- 检测 Syncthing event ID 断裂并强制 snapshot；
- 提供 ready、live 和 degraded 状态；
- 拒绝旧 desired revision；
- 对每个 mutation 执行幂等和 read-after-timeout。

不得负责：

- 用户、组织和 membership 业务决策；
- 保存组织级 Desired State；
- 直接向桌面客户端提供管理接口；
- 将 Syncthing API Key 返回给 Control Plane；
- 绕过 Control Plane 创建永久设备或文件夹。

Control Plane 到 Hub Agent 使用集群内部 mTLS、独立 service identity 和 NetworkPolicy。Syncthing REST 继续只监听 Pod loopback。

## 5.6 Electron Desktop Host

负责：

- 应用、窗口、菜单和托盘；
- Local Runtime 与 Syncthing Client 监督；
- Directory Grant；
- Credential Reference；
- 通知、更新器和深链接；
- 私有 bootstrap channel；
- 平台签名和安装包；
- Host Capability API。

不得负责：

- 同步空间业务规则；
- 用户和设备 Repository；
- 远端 HTTP 工作流；
- 将业务 API 放入 Electron IPC。

## 5.7 Desktop Local Runtime

负责：

- 独立、Node-compatible、可 Headless 启动；
- 对 Renderer 暴露正式 REST、JSON、SSE 和 OpenAPI；
- 登录和设备注册用例；
- Control Plane Server Connection Manager；
- 服务端策略和 revision 缓存；
- 本机 Directory Grant binding；
- 本机 Syncthing Desired State；
- 本地 reconciliation；
- 离线状态和错误；
- 本地活动与诊断。

Local Runtime 不是组织级业务事实源。服务器恢复连接后，以 Control Plane revision 为准调和组织状态。

## 5.8 Desktop Syncthing Client

负责：

- 扫描本机同步目录；
- 只连接被分配的 Hub；
- 上传和下载文件；
- 文件块索引；
- 本机冲突与版本行为；
- 实时进度和错误。

不得配置其他桌面设备为远端 peer。

---

# 6. 事实源与数据所有权

## 6.1 权威来源

| 数据                          | 权威来源                     |
| ----------------------------- | ---------------------------- |
| 用户、组织、会话              | Control Plane PostgreSQL     |
| 产品设备、批准和吊销          | Control Plane PostgreSQL     |
| Syncthing Device ID 绑定      | Control Plane PostgreSQL     |
| 同步空间、成员和 Hub 分配     | Control Plane PostgreSQL     |
| 服务端配额和审计              | Control Plane PostgreSQL     |
| 服务器文件当前内容            | Hub data PVC                 |
| 服务器 Syncthing index        | Hub state PVC                |
| 服务器文件版本                | Hub data/version PVC         |
| 本机目录授权和真实路径        | Desktop Host Grant Store     |
| 本机 grantId binding          | Desktop Local Runtime SQLite |
| 本地策略缓存和 reconciliation | Desktop Local Runtime SQLite |
| 本机文件当前内容              | Desktop filesystem           |
| 传输、扫描和连接状态          | 对应 Syncthing Engine        |

## 6.2 不能混淆的状态

Control Plane 中“设备是空间成员”表示组织希望该设备获得访问。

Hub 中“device 已配置到 folder”表示服务器执行投影已经完成。

Desktop 中“folder 已绑定 grantId”表示本机用户已经选择目录。

只有三者都满足时，DeviceSpaceBinding 才能进入 active。

## 6.3 数据原则

- 组织状态只在 Control Plane 修改；
- Desktop SQLite 只缓存服务器状态和保存本机状态；
- Hub REST 结果不能直接成为管理 API 响应；
- Hub config 不作为 PostgreSQL 的备份；
- 客户端不能通过修改本地 SQLite 获得服务器成员权限；
- 服务器永远不接收桌面绝对路径；
- 文件内容不进入 PostgreSQL；
- 观测状态必须携带 Hub 或 Engine generation。

---

# 7. 核心领域模型

## 7.1 Organization

拥有：

- users；
- devices；
- sync spaces；
- quotas；
- audit policy。

## 7.2 ProductDevice

关键字段：

- productDeviceId；
- organizationId；
- userId；
- displayName；
- product public key；
- syncthingDeviceId；
- syncthingBindingState；
- approvalState；
- assignedHubId；
- lastSeenAt；
- clientVersion；
- desiredRevision；
- observedRevision。

状态：

    registering
        → pending_approval
        → verifying_syncthing_identity
        → active
        → suspended
        → revoked

revoked 是终态。重新加入时创建新的产品设备注册记录，不复活旧授权。

## 7.3 Hub

关键字段：

- hubId；
- syncthingDeviceId；
- endpoint；
- statefulSetName；
- storageClass；
- capacity；
- allocatedBytes；
- desiredRevision；
- observedRevision；
- generation；
- health。

状态：

    provisioning
        → ready
        → degraded
        → recovering
        → decommissioning
        → decommissioned

## 7.4 SyncSpace

一个 SyncSpace 在 Hub 上映射为一个稳定 Syncthing folder。

关键字段：

- syncSpaceId；
- organizationId；
- hubId；
- syncthingFolderId；
- label；
- quota；
- lifecycleState；
- versionPolicy；
- desiredRevision；
- observedRevision。

状态：

    draft
        → provisioning
        → active
        → paused
        → deleting
        → deleted

## 7.5 SpaceMembership

表示 ProductDevice 获得某个 SyncSpace 的成员资格。

关键字段：

- membershipId；
- syncSpaceId；
- productDeviceId；
- accessClass；
- state；
- desiredRevision；
- hubAppliedRevision。

v1.0 的 accessClass 只有 member，并按读写成员处理。

重要限制：

Syncthing folder type 的 sendonly、receiveonly 和 sendreceive 是本地行为配置，不是可靠的服务端授权边界。恶意或被控制的客户端可以修改自身行为。因此：

- v1.0 不宣称具备强制只读成员；
- 所有成员在安全模型中视为可以上传修改；
- UI 可以提供 receive-only 体验，但不能把它表达为服务器强制权限；
- 真正的只读分发需要后续建立独立 ExportSpace 或服务端发布流水线。

## 7.6 DeviceSpaceBinding

是桌面本地对象，连接服务器 membership 与本机 Directory Grant。

关键字段：

- syncSpaceId；
- membershipRevision；
- directoryGrantId；
- localMode；
- localDesiredState；
- localObservedState；
- localEngineGeneration。

状态：

    offered
        → awaiting_directory
        → provisioning
        → syncing
        → paused
        → removing
        → removed

---

# 8. 身份、注册与认证

## 8.1 用户认证

Control Plane Remote Server Mode 必须使用：

- TLS；
- durable user authentication；
- 短期 access token；
- 可撤销 refresh session；
- Origin 和 CORS policy；
- rate limit；
- request size limit；
- audit；
- session revocation。

v1.0 使用管理员邀请和本地账户，密码与恢复流程独立实现；OIDC 不在本版本范围内。

## 8.2 产品设备身份

产品设备身份不能只依赖 Syncthing Device ID。

桌面首次启动：

1. Host 生成或导入产品设备密钥；
2. 私钥保存到系统 Credential Provider；
3. Local Runtime 生成 Syncthing identity；
4. 客户端向 Control Plane 提交产品公钥和 Syncthing Device ID；
5. 用户或管理员批准；
6. Control Plane 将设备置为 verifying_syncthing_identity；
7. Control Plane 在 Hub 上创建无 folder 权限的临时 device entry；
8. Desktop Syncthing 使用分配的 Hub endpoint 建立连接；
9. Hub Agent 观察到由目标 Syncthing Device ID 完成认证的连接；
10. Control Plane 将产品设备身份与 Syncthing Device ID 标记为 verified binding；
11. 临时验证 entry 转为正式 device config，或者在超时后删除；
12. Control Plane 将设备置为 active 并下发策略 revision。

产品设备密钥用于控制面认证。Syncthing Device ID 用于文件数据面认证。

Control Plane 不能因为客户端提交了一个格式正确的 Device ID 字符串就认为绑定成立。只有 Hub 观察到该证书身份实际完成连接后，设备才能获得 SyncSpace membership。验证窗口必须短期、可取消、可审计，并限制重复尝试。

## 8.3 设备吊销

吊销事务：

    mark ProductDevice revoked
        → invalidate product sessions
        → remove memberships from Desired State
        → enqueue Hub reconciliation
        → remove device from Hub folders
        → optionally remove device from Hub config
        → emit audit event

安全成功条件是 Hub 已经移除该 device，而不是客户端收到吊销通知。

## 8.4 Desktop Local Mode

Renderer 到 Local Runtime 仍采用桌面架构基线：

- loopback；
- per-start random token；
- explicit Origin allowlist；
- runtime ID；
- runtime generation；
- 一次性 bootstrap nonce；
- 每窗口 session。

Runtime token、Host token 和 Syncthing API Key 必须相互独立。

---

# 9. 同步空间工作流

## 9.1 创建设备

    user signs in
        → register product device
        → submit Syncthing Device ID
        → approval
        → assign Hub
        → create temporary no-folder Hub device entry
        → return Hub identity and endpoint
        → Desktop Runtime configures Hub as the only peer
        → Hub Agent observes authenticated Syncthing connection
        → verify product-device / Syncthing identity binding
        → report observed revision

## 9.2 创建同步空间

    POST SyncSpace
        → validate quota and Idempotency-Key
        → write SyncSpace desired state
        → write domain event
        → write reconciliation job
        → commit PostgreSQL transaction
        → provision Hub directory
        → create Hub Syncthing folder
        → enable server version policy
        → read back Hub observed state
        → mark SyncSpace active

API 需要区分 accepted 和 applied。

## 9.3 添加成员设备

    add SpaceMembership
        → validate device is active and assigned to compatible Hub
        → commit membership desired state
        → add device to Hub if missing
        → share Hub folder with device
        → publish space.offer to Desktop
        → Desktop user selects local Directory Grant
        → Desktop configures local folder shared only with Hub
        → Desktop reports binding observed revision

## 9.4 客户端上传

    local file changes
        → Desktop Syncthing scans
        → encrypted transport to Hub
        → Hub writes server file
        → Hub index updates
        → other authorized clients download later

发送设备在 Hub 完成接收后可以离线。

## 9.5 移除成员

    remove membership
        → commit desired removal
        → immediately remove device from Hub folder
        → publish removal revision
        → Desktop removes local Engine binding
        → preserve local files according to explicit user policy
        → retain membership tombstone for audit and idempotency

服务器移除 membership 不得默认删除该设备本地已有文件。桌面端需要明确提示“停止同步”和“删除本地副本”是两个不同操作。

## 9.6 删除同步空间

删除分为：

    active
        → deleting
        → access_removed
        → retention_window
        → data_deleted
        → deleted

必须先撤销 Hub folder 访问，再依据保留策略删除服务器文件。不能在单个同步 HTTP 请求中直接永久删除 PVC 数据。

---

# 10. Desired State 与三层调和

服务器模型包含三个 Reconciler。

## 10.1 Control Plane → Hub Agent → Hub

输入：

- Hub Desired State；
- SyncSpace；
- ProductDevice；
- SpaceMembership；
- version policy。

输出：

- Hub device config；
- Hub folder config；
- folder-device relation；
- pause/resume/remove；
- observed revision；
- drift 和 error。

Control Plane 不直接调用 Syncthing REST。Hub Agent 是唯一允许持有 Hub API Key 和翻译 Vendor Contract 的进程。

## 10.2 Control Plane → Desktop

Control Plane 不主动远程调用桌面 Host。

Desktop 通过 HTTPS/SSE 主动获取：

- assigned Hub；
- device desired state；
- SyncSpace offer；
- membership revision；
- policy；
- minimum client version；
- revocation。

断线后使用 cursor replay；cursor 缺口时获取完整 snapshot。

## 10.3 Desktop Runtime → Desktop Syncthing

输入：

- server membership revision；
- Hub identity and endpoint；
- local Directory Grant；
- local mode；
- local policy。

输出：

- local folder and device config；
- local observed revision；
- progress and error；
- binding status。

## 10.4 Mutation 规则

所有服务器 mutation：

    validate
        → begin PostgreSQL transaction
        → write desired state
        → write domain event
        → write reconciliation job
        → write idempotency result
        → commit
        → async apply
        → observe
        → publish status

普通非幂等 mutation 不自动盲重试。

使用：

- stable resource ID；
- Idempotency-Key；
- ETag / If-Match；
- read-after-timeout；
- tombstone；
- forward-only state transition。

---

# 11. Syncthing 配置模型

## 11.1 Hub 配置

Hub：

- 使用固定、持久化的 Syncthing identity；
- REST API 只监听 Pod loopback；
- REST API 只允许同 Pod 的 Hub Agent 访问；
- Web GUI 不通过 Service 或 Ingress 暴露；
- 只允许 Control Plane Reconciler 管理；
- 禁止自动接受未知设备和文件夹；
- 禁止 global discovery；
- 禁止 public relay；
- 禁止 NAT traversal；
- 使用明确的同步监听地址；
- 对每个 SyncSpace 设置独立 folder ID 和路径；
- 使用服务器版本策略；
- 配置磁盘剩余空间保护。

## 11.2 Desktop 配置

Desktop：

- 使用应用私有 Syncthing home；
- REST API 只监听 loopback；
- 只配置一个或少量被 Control Plane 分配的 Hub device；
- 不配置其他 ProductDevice；
- 禁止 local discovery；
- 禁止 global discovery；
- 禁止 public relay；
- 禁止 NAT traversal；
- 使用 Control Plane 下发的 Hub 明确地址；
- 禁止自动接受未知设备和文件夹；
- 不允许用户打开原生 Syncthing GUI 修改受管字段。

## 11.3 Hub 身份稳定性

以下内容必须持久化并随 StatefulSet 恢复：

- Syncthing identity key；
- Syncthing config；
- Syncthing index；
- Hub generation metadata。

Pod 重建不能产生新的 Syncthing Device ID。

## 11.4 文件版本

服务器 Hub 是长期在线接收方，适合启用服务器版本策略。

v1.0 固定策略：

- 默认 staggered versioning，最长保留 30 天；
- 版本存储与正常文件分开计量；
- 暴露版本容量；
- 设置 retention 和清理任务；
- 明确说明版本功能不替代 PVC snapshot。

---

# 12. Directory Grant 与路径安全

桌面目录选择流程：

    Renderer
        → Local Runtime directory-selection use case
        → Runtime calls Host Directory Grant capability
        → Host shows native directory picker
        → Host returns grantId and safe display label
        → Local Runtime persists grantId
        → Syncthing Adapter resolves path only when applying local config

要求：

- Renderer 不获得绝对路径；
- Control Plane 不获得绝对路径；
- PostgreSQL 不保存绝对路径；
- Local Runtime 原则上只持久化 grantId；
- Host 持久保存 grant 到路径的受控映射；
- grant 可撤销；
- 日志、事件和诊断脱敏；
- v1.0 禁止本机同步目录嵌套；
- 可移动磁盘消失产生 StorageUnavailable；
- 远端 SyncSpace 不能指定客户端落盘路径。

服务器 SyncSpace 路径由 Hub Reconciler 根据 syncSpaceId 生成，不能使用用户输入直接拼接文件系统路径。

---

# 13. 网络模型

## 13.1 控制面

桌面客户端主动连接：

    HTTPS 443
        → Internal Ingress or Load Balancer
        → Control Plane API

支持：

- REST；
- fetch-based SSE；
- TLS；
- durable authentication；
- request limits；
- rate limits。

Control Plane 不回连桌面 Local Runtime。

## 13.2 数据面

桌面 Syncthing 主动连接：

    Hub TCP / QUIC sync endpoint
        → Kubernetes Service
        → single Hub Pod

端口由部署配置明确发布。Syncthing REST/Web GUI 端口不发布。

## 13.3 NetworkPolicy

至少限制：

- 只有 Control Plane Reconciler 可以访问 Hub Agent Management Service；
- Hub Agent Management Service 使用 mTLS，不等同于仅依赖 NetworkPolicy；
- Syncthing REST 只接受 Pod loopback，不创建 Kubernetes Service；
- Hub 只访问必要的 DNS、数据库外部不需要的目标和同步客户端；
- PostgreSQL 只接受 Control Plane；
- Control Plane 不能直接访问桌面目录；
- 管理端点与用户端点分离；
- Metrics 端点只允许监控命名空间。

## 13.4 无公网依赖

局域网部署默认不需要：

- Syncthing global discovery；
- Syncthing public relay；
- 公网 STUN；
- SaaS Control Plane；
- 公网对象存储。

产品更新源是否访问公网是独立产品决策。

---

# 14. Kubernetes 部署

## 14.1 v1.0 组件

建议命名空间：

    kitesync-system
        control-plane
        postgres
        monitoring

    kitesync-data
        syncthing-hub-0 + hub-agent
        backup-jobs

初始工作负载：

- Control Plane Deployment，v1.0 一副本；
- PostgreSQL StatefulSet 或组织已有的托管 PostgreSQL；
- Syncthing Hub StatefulSet，一副本，每个 Pod 包含 Hub Agent sidecar 和 Syncthing container；
- Hub data PVC；
- Hub state PVC；
- API Ingress；
- Hub Management Service，仅供 Control Plane 使用；
- Syncthing Data Service；
- CronJob backup；
- ServiceMonitor 或等价监控。

## 14.2 为什么 Hub 不能普通多副本

同一个 Hub 的 Syncthing identity、config、index 和文件状态构成单写者状态。

禁止：

- 多个 Pod 同时使用同一 Syncthing home；
- 多个 Pod 同时写同一个 folder PVC；
- 通过 Deployment replicas 直接水平扩容 Hub；
- 将流量随机分配给身份和索引不一致的 Hub Pod。

v1.0 高可用策略：

- StatefulSet 单副本；
- 稳定 PVC；
- Pod 失败后由 Kubernetes 重建；
- identity 和 state 从持久卷恢复；
- 监控 RTO；
- 定期备份和恢复演练。

## 14.3 扩容模型

规模增长后按 shard 扩容：

    Organization / SyncSpace
        → Hub Assignment
        → Hub Shard

每个 Hub Shard 拥有：

- 独立 Syncthing identity；
- 独立 StatefulSet；
- 独立 state PVC；
- 独立 data PVC；
- 独立容量和健康状态。

一个 SyncSpace 在同一时刻只属于一个 Hub。跨 Hub 迁移需要独立的 Migration Workflow，不能只修改 hubId。

## 14.4 配置和 Secret

Kubernetes Secret 保存：

- Hub Agent mTLS identity；
- Pod 内 Hub Agent 调用 Syncthing 所需的 API credential；
- Control Plane database credential；
- 服务端签名密钥引用；
- TLS key reference。

Hub identity key 优先放在加密持久卷或专用 Secret，并保证恢复后身份不变。密钥轮换必须有独立流程，不能依赖 Pod 重建。

---

# 15. 存储、版本与备份

## 15.1 存储分层

服务器至少区分：

1. PostgreSQL 数据；
2. Hub Syncthing state 和 index；
3. 当前文件数据；
4. Syncthing 文件版本；
5. 备份和 snapshot。

不能把 PostgreSQL backup 当作文件备份，也不能把 Syncthing index 当作文件副本。

## 15.2 配额

配额至少包含：

- organization quota；
- SyncSpace quota；
- version quota；
- minimum free space；
- maximum file count；
- optional maximum single file size。

容量不足时：

- 阻止新 SyncSpace provisioning；
- 对现有空间产生 QuotaExceeded；
- 不伪造同步成功；
- 通知管理员；
- 保留审计；
- 避免自动删除当前文件。

## 15.3 备份

v1.0 需要：

- PostgreSQL 定期备份；
- Hub data PVC snapshot 或文件级备份；
- Hub identity/config/state 备份；
- 备份加密；
- retention；
- 定期 restore drill；
- 明确 RPO 和 RTO。

Syncthing versioning 用于快速恢复远端覆盖和删除。PVC backup 用于介质损坏、误操作和集群灾难。两者必须同时存在。

## 15.4 服务器可读性

普通 Hub 模式下，文件以可用明文形式存在于服务器文件系统。

因此：

- 存储层应启用 at-rest encryption；
- Kubernetes 管理员属于可信边界；
- 备份必须加密；
- 诊断和日志不得采集正文；
- UI 必须向用户说明服务器持有文件副本。

如果未来要求服务器不可读取文件，需要重新设计加密、搜索、版本恢复和权限模型，不能在当前架构上仅增加一个开关。

---

# 16. HTTP Contract 与事件

## 16.1 Control Plane 基础端点

    GET /health
    GET /api/v1/version
    GET /api/v1/capabilities
    GET /api/v1/runtime
    GET /api/v1/events

GET /health 不返回 token、内部地址、Hub credential 或敏感 topology。

## 16.2 Control Plane 领域端点

初始资源：

    sessions
    organizations
    users
    devices
    hubs
    sync-spaces
    memberships
    provisioning-operations
    quotas
    audit-events
    policies

示例：

    POST   /api/v1/device-registrations
    GET    /api/v1/devices
    POST   /api/v1/devices/{id}/approve
    POST   /api/v1/devices/{id}/suspend
    DELETE /api/v1/devices/{id}

    GET    /api/v1/sync-spaces
    POST   /api/v1/sync-spaces
    PATCH  /api/v1/sync-spaces/{id}
    DELETE /api/v1/sync-spaces/{id}

    POST   /api/v1/sync-spaces/{id}/memberships
    DELETE /api/v1/sync-spaces/{id}/memberships/{membershipId}

## 16.3 Desktop Local Runtime 端点

    GET  /health
    GET  /api/v1/version
    GET  /api/v1/capabilities
    GET  /api/v1/runtime
    GET  /api/v1/events

    GET  /api/v1/account
    GET  /api/v1/device
    GET  /api/v1/sync-spaces
    POST /api/v1/sync-spaces/{id}/bind-directory
    POST /api/v1/sync-spaces/{id}/pause
    POST /api/v1/sync-spaces/{id}/resume
    GET  /api/v1/activity
    GET  /api/v1/diagnostics

Renderer 只调用 Local Runtime。由 Local Runtime 通过生成的 Server Client 调用 Control Plane，避免 Renderer 同时持有两套认证和连接状态。

## 16.4 Contract 要求

所有正式 API：

- REST；
- JSON；
- OpenAPI；
- stable operationId；
- RFC 7807 Problem Details；
- Trace ID；
- ETag / If-Match；
- Idempotency-Key；
- cursor pagination；
- AbortSignal 和 timeout；
- request/response schema；
- 明确的 accepted、applied、degraded 和 failed 语义。

## 16.5 服务器事件

持久 Domain Event 示例：

- device.registered；
- device.approved；
- device.revoked；
- sync-space.created；
- sync-space.ready；
- membership.added；
- membership.removed；
- hub.reconciliation.failed；
- quota.exceeded；
- backup.completed。

Realtime Event 示例：

- device.heartbeat；
- hub.health；
- sync.progress；
- connection.changed。

Domain Event：

- PostgreSQL 同事务写入；
- 全局或租户 cursor；
- at-least-once；
- 可重放；
- Client 幂等消费。

Realtime Event：

- 可以丢弃；
- 断线后通过 snapshot 恢复；
- 不与 Domain Event 混用 cursor。

---

# 17. Desktop 架构约束

桌面端继续完整遵守 Level 1。

## 17.1 Renderer

负责 UI、交互和 Client cache。

不得获得：

- Electron business IPC；
- SQLite；
- Control Plane refresh token plaintext；
- Host token；
- Syncthing API Key；
- 任意绝对路径；
- Vendor DTO。

## 17.2 Local Runtime

推荐内部结构：

    runtime/
    ├── bootstrap/
    ├── http/
    ├── application/
    ├── domain/
    │   ├── account/
    │   ├── device/
    │   ├── bindings/
    │   ├── activity/
    │   └── diagnostics/
    ├── repositories/
    ├── tasks/
    │   └── reconciliation/
    └── adapters/
        ├── sqlite/
        ├── control-plane/
        ├── syncthing/
        └── host-capability/

## 17.3 Server Connection Manager

Local Runtime 到 Control Plane：

    idle
        → discovering
        → authenticating
        → negotiating
        → ready
        → reconnecting
        → degraded
        → disconnected
        → incompatible

连接恢复只自动重放：

- 安全 GET；
- cursor event stream；
- 显式幂等请求。

普通非幂等 mutation 必须查询 Idempotency-Key 结果。

## 17.4 Local SQLite

建议表：

    account_session_metadata
    product_device_cache
    server_revision_cache
    sync_space_cache
    device_space_bindings
    local_reconciliation_jobs
    local_domain_events
    idempotency_records
    app_settings

refresh token、产品设备私钥和路径不进入普通 SQLite 明文表。

---

# 18. 故障模型与恢复

## 18.1 Control Plane 不可用

预期：

- 已配置的 Desktop Syncthing 继续与 Hub 同步；
- 不能注册新设备；
- 不能创建或改变 membership；
- Local Runtime 显示 control-plane degraded；
- 连接恢复后从 cursor 或 snapshot 追平。

## 18.2 PostgreSQL 不可用

预期：

- Control Plane mutation 停止；
- 不接受无法持久化的授权变化；
- Hub 继续执行已有配置；
- 告警；
- 数据库恢复后重新调和。

## 18.3 Hub 不可用

预期：

- 所有客户端保留本地变更；
- Syncthing 自动重试；
- Control Plane 显示 Hub degraded；
- 不报告同步完成；
- StatefulSet 使用同一 identity 和 PVC 恢复；
- 恢复后继续块级同步。

## 18.4 Hub PVC 容量不足

预期：

- Hub 进入 degraded；
- 新 provisioning 被拒绝；
- 管理员收到明确告警；
- 不自动删除当前文件；
- version cleanup 只能按明确 retention 执行；
- 扩容或清理后重新扫描并恢复。

## 18.5 Desktop Local Runtime 崩溃

Desktop Host 使用 backoff、jitter 和预算重启。

Syncthing Client 可以在短暂 Runtime 重启期间继续已有同步。Runtime 恢复后必须：

- 更换 runtime generation；
- Renderer 丢弃旧 cache 和 SSE；
- 重新获取 Control Plane revision；
- 重新读取本地 Engine snapshot；
- 执行 reconciliation。

## 18.6 Desktop Syncthing 崩溃

预期：

- Host 重启 Engine；
- Engine generation 改变；
- Runtime 终止旧 event long-poll；
- 获取完整 snapshot；
- 重新应用 Hub-only peer policy；
- 重新调和 folder binding。

## 18.7 有序关闭

Desktop：

    stop new mutations
        → finish or persist local transactions
        → close streams
        → stop Syncthing
        → stop Local Runtime
        → exit Host

Server：

    fail readiness
        → stop accepting new mutations
        → persist or release jobs
        → close event streams
        → close database
        → exit

Hub 独立按 StatefulSet 生命周期有序停止和落盘。

---

# 19. 安全基线

必须满足：

1. Control Plane 只通过 TLS 暴露。
2. 使用 durable user 和 device authentication。
3. 产品设备身份与 Syncthing Device ID 只有在 Hub 观察到认证连接后才不可变绑定。
4. 吊销以 Hub 移除设备为安全完成条件。
5. Hub REST/Web GUI 不创建 Service，只允许同 Pod Hub Agent 通过 loopback 访问。
6. Desktop Syncthing REST 只监听 loopback。
7. Renderer 不获得服务器 refresh token、Host token 或 Syncthing API Key。
8. 服务器不获得桌面绝对路径。
9. 未知设备和文件夹不自动接受。
10. Hub identity、数据库和备份密钥受到 Secret 与存储加密保护。
11. 所有 mutation 有 authorization、audit 和 trace。
12. 文件名、设备名、URL、事件 payload 和 Syncthing DTO 按不可信输入处理。
13. 诊断包脱敏账户、Device ID、IP、路径、token 和文件名。
14. Syncthing 服务器和客户端使用经过兼容测试的固定版本。
15. Syncthing 自更新关闭，由 KiteSync 统一升级。
16. 分发包和服务器镜像包含对应许可证与源码获取方式。
17. Kubernetes RBAC 使用最小权限。
18. NetworkPolicy 限制 PostgreSQL、Hub Agent Management Service 和 Metrics。
19. PVC 和备份启用 at-rest encryption。
20. 用户被明确告知服务器持有可读文件副本。

---

# 20. 仓库结构

建议：

    kitesync/
    ├── apps/
    │   ├── desktop/
    │   │   ├── main/
    │   │   ├── preload/
    │   │   └── renderer/
    │   └── control-plane/
    ├── services/
    │   └── hub-agent/
    ├── packages/
    │   ├── desktop-runtime/
    │   ├── desktop-host/
    │   ├── control-plane-runtime/
    │   ├── hub-agent-contracts/
    │   ├── contracts/
    │   │   ├── desktop-api/
    │   │   ├── server-api/
    │   │   └── host-api/
    │   ├── clients/
    │   │   ├── desktop-client/
    │   │   └── server-client/
    │   ├── syncthing-adapter/
    │   └── ui/
    ├── deploy/
    │   └── kubernetes/
    │       ├── base/
    │       └── overlays/
    ├── vendor/
    │   └── syncthing/
    ├── docs/
    ├── scripts/
    └── tests/
        ├── contract/
        ├── server-integration/
        ├── desktop-integration/
        ├── hub-reconciliation/
        ├── hub-agent-contract/
        ├── fault-injection/
        ├── desktop-e2e/
        └── kubernetes-smoke/

依赖方向：

    renderer → generated desktop client → desktop contracts
    desktop runtime → generated server client → server contracts
    control plane → domain/application → repository and hub ports
    control plane hub port → generated Hub Agent client
    Hub Agent → Syncthing Adapter → loopback Vendor API
    syncthing adapters → declared application ports
    desktop host → host contracts

禁止：

- Control Plane domain import Kubernetes 或 Syncthing DTO；
- Desktop Runtime import Electron；
- Renderer 直接调用 Control Plane；
- Renderer 使用 Electron business IPC；
- Hub REST DTO 穿过正式 Server API；
- Control Plane 直接调用 Syncthing REST；
- Desktop 与 Hub 共享 SQLite；
- Control Plane 直接修改 PVC 中的 Syncthing config.xml；
- 业务模块跨边界直接访问其他 Repository。

---

# 21. 实施阶段

## Phase 0：Contract 与骨架

- 建立 Control Plane Runtime；
- 建立 PostgreSQL migration；
- 建立服务器 REST、SSE、OpenAPI 和 Problem Details；
- 建立桌面 Host、Local Runtime 和 Renderer；
- 建立两套生成 Client；
- 建立 bootstrap、generation 和 Connection Manager；
- 建立 Domain Event 与 Idempotency。

## Phase 1：单 Hub 数据面

- 在 K8s 部署单副本 Syncthing Hub StatefulSet；
- 在 Hub Pod 内部署 Hub Agent sidecar；
- 建立 Hub Agent mTLS Management Contract；
- 建立 state PVC 与 data PVC；
- 固定并持久化 Hub identity；
- 建立仅由 Hub Agent 使用的 Syncthing REST/Event Adapter；
- 建立 Hub Reconciler；
- 建立 Syncthing Data Service；
- 完成 Hub snapshot 和 generation；
- 验证 Pod 重建后 Device ID 不变。

## Phase 2：设备注册

- 用户认证或邀请；
- 产品设备密钥；
- Syncthing Device ID 绑定；
- 管理员批准和吊销；
- Hub 分配；
- Desktop 只配置 Hub peer；
- 设备心跳、状态和兼容性。

## Phase 3：同步空间

- SyncSpace；
- SpaceMembership；
- Hub folder provisioning；
- Desktop Directory Grant binding；
- 上传、延迟下载和离线恢复；
- 暂停、移除和删除保留窗口；
- 文件版本和容量统计。

## Phase 4：运维与发布

- 配额；
- PostgreSQL 和 PVC backup；
- restore drill；
- Metrics、Logs 和 Alerts；
- NetworkPolicy 和 RBAC；
- 三平台桌面安装包与签名；
- 控制面和 Hub 升级；
- 兼容矩阵和回滚。

## Phase 5：分片

只有单 Hub 达到容量、设备数或 IOPS 边界后才实施：

- Hub inventory；
- shard assignment；
- per-Hub quota；
- Hub Manager；
- SyncSpace migration workflow；
- 分片故障隔离。

---

# 22. 测试与验收

## 22.1 测试层次

- Domain unit；
- PostgreSQL integration；
- Server HTTP contract；
- Desktop HTTP contract；
- Hub Adapter contract；
- Reconciler integration；
- Headless desktop conformance；
- fault injection；
- multi-client desktop E2E；
- Kubernetes package and upgrade smoke；
- backup and restore drill。

## 22.2 必须覆盖

- 重复 Idempotency-Key；
- stale If-Match；
- mutation 服务端提交后客户端超时；
- Control Plane crash 和 generation 切换；
- PostgreSQL 短暂不可用；
- Hub Pod 重建；
- Hub identity 恢复；
- Hub REST 事件断裂；
- Hub Agent crash、重启和 generation 切换；
- 非 Control Plane workload 调用 Hub Agent 被拒绝；
- Hub PVC 容量不足；
- Desktop Local Runtime crash；
- Desktop Syncthing crash；
- Desktop 离线后追平 revision；
- 客户端上传完成后关机，另一客户端稍后下载；
- 设备吊销后无法重新连接 Hub；
- membership 移除后服务器停止向该设备提供更新；
- 用户未选择 Directory Grant；
- Directory Grant 被撤销；
- 可移动磁盘临时消失；
- 大文件和海量小文件；
- 重命名、删除和冲突；
- 服务器版本恢复；
- PostgreSQL restore；
- Hub data restore；
- 控制面不可用时既有同步继续；
- 客户端配置中不存在其他桌面 peer；
- global discovery、public relay 和 NAT traversal 均关闭；
- Hub REST/Web GUI 没有 Kubernetes Service，不能从其他 Pod 或客户端网络访问；
- shutdown 后长期资源数量归零。

## 22.3 v1.0 验收标准

1. 管理员可以注册、批准和吊销桌面设备。
2. 用户可以创建 SyncSpace，并把多个已批准设备加入空间。
3. 每台桌面设备可以独立选择本地目录。
4. Desktop A 上传完成并关机后，Desktop B 仍可从 Hub 下载完整文件。
5. 所有桌面 Syncthing 只连接 Hub，不连接其他桌面设备。
6. Hub Pod 重建后 identity、文件和索引可以恢复。
7. Control Plane 短暂不可用时已有文件同步继续。
8. 被吊销设备从 Hub 移除后不能继续同步。
9. 服务器版本、PVC backup 和 PostgreSQL backup 均可恢复。
10. Renderer 无法取得服务器 refresh token、Host token、Syncthing API Key 或绝对路径。
11. 默认部署不访问 Syncthing 公共 discovery 和 relay。
12. 用户明确知道服务器持有文件明文副本。

---

# 23. 扩展边界

## 23.1 只读分发

不能仅用客户端 receiveonly 实现安全的只读权限。

需要强制只读时，新增独立模型：

    Writable Source Space
        → server-controlled publish workflow
        → Read-only Export Space
        → subscriber devices

发布过程由服务器复制或快照，订阅设备不能成为 Source Space 成员。

## 23.2 服务器不可读

如果要求 Kubernetes 管理员无法读取内容，需要重新评估：

- client-side content encryption；
- key distribution；
- encrypted versioning；
- conflict handling；
- metadata leakage；
- restore；
- malware scanning；
- server-side preview；
- protocol compatibility。

这属于独立安全架构，不纳入当前 Hub 明文模型。

## 23.3 公网访问

当前是局域网服务器版本。

未来开放公网时必须增加：

- public threat model；
- WAF 和 DDoS policy；
- internet TLS certificate；
- stronger rate limits；
- remote access audit；
- endpoint posture；
- data residency；
- incident response。

不能仅把现有 K8s Service 改成公网 LoadBalancer。

## 23.4 Level 升级

桌面客户端仍是 Level 1。

出现多个真实信号时才升级 Level 2：

- 多个稳定业务域由不同团队维护；
- 需要 enterprise、safe、server 等多个 Product Profile；
- 模块需要独立生命周期；
- route、event、migration 和 task 注册难以治理；
- 内部能力需要稳定组合。

只有存在真实第三方生态时才考虑 Level 3。

---

# 24. v1.0 已冻结产品决策

1. 生产 StorageClass 必须支持 RWO 与 CSI VolumeSnapshot；开发用本地快照 Adapter。
2. Hub 对桌面开放 TCP/QUIC 22000，管理面仅走内部 mTLS。
3. 容量目标为 100 用户、300 设备、100 空间和 10 TiB。
4. Helm 支持内置 PostgreSQL 17 或外部 PostgreSQL；开发固定使用 Compose PostgreSQL 17。
5. 用户认证使用本地账户、邀请、Argon2id、可撤销 Web/desktop session。
6. 服务器默认 staggered versioning 最长 30 天；删除空间回收站保留 30 天。
7. 数据库 RPO 15 分钟，文件 RPO 24 小时，整体 RTO 4 小时。
8. Kubernetes 管理员属于可信边界，服务器持有并可读取明文文件。
9. 不提供安全只读；所有成员均按可读写处理。
10. 移除 membership/本地 binding 时保留客户端本地文件。
11. 只允许完成产品身份注册和批准的 KiteSync 客户端接入，不支持原生 Syncthing 客户端。
