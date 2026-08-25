# 备份与空集群恢复

## 备份模型

内置 PostgreSQL 开启 WAL archive，`archive_timeout=900`，pgBackRest 将 WAL 与每日 full backup 写入 S3，数据库目标 RPO 为 15 分钟。Hub 每日由 Backup Controller 执行：

1. 使用 mTLS 请求 Hub quiesce 并取得稳定 snapshot revision；
2. 为 Hub state PVC 和 data PVC 创建同 revision 的 CSI `VolumeSnapshot`；
3. 在 `finally` 路径立即恢复 Hub 同步；
4. 从快照创建临时克隆 PVC，由短生命周期 Restic Job 加密上传 S3并执行校验；
5. 回调 Control Plane 写入 `BackupRun` 和审计状态；
6. 按 30 日、12 周、12 月保留策略裁剪对象与 CSI 快照。

文件目标 RPO 为 24 小时、整体 RTO 为 4 小时。Restic 密码、S3 Secret 和 Backup Controller token 必须进入组织 Secret 管理系统。

## 恢复前检查

选定恢复点后必须将 PostgreSQL、Hub identity/state、文件数据和版本目录对应到同一业务时间点。记录原 Hub Device ID、snapshot revision、Chart/镜像版本、数据库备份 label 和对象校验结果。恢复期间阻断桌面到 Hub 的 22000 流量。

## 空集群恢复步骤

1. 创建新 namespace、StorageClass、VolumeSnapshotClass、TLS/mTLS 和 S3 凭据。
2. 创建 PostgreSQL PVC，在临时恢复 Pod 中执行 pgBackRest `restore`，按需要用 WAL 恢复到目标时间；启动数据库并运行一致性检查，但暂不启动 Control Plane Worker。
3. 优先从所选 CSI snapshot 创建 Hub state/data PVC；跨集群时用同一 Restic snapshot 分别恢复两个克隆卷。不得混用不同 revision。
4. 用 `helm upgrade --install` 绑定预恢复 PVC 和匹配的应用版本，保持 Syncthing Service 暂时封锁。
5. 读取 Hub Agent `/runtime` 与 `/snapshot`，确认 Hub Device ID 等于备份记录、folder/version 数据完整、generation 可接受。
6. 启动 Control Plane，执行前向迁移，观察完整 Desired State 调和和 read-after 验证；确认不存在意外删除任务。
7. 用隔离测试桌面下载抽样文件并校验 SHA-256，执行一次服务器历史版本恢复演练。
8. 放开 22000 流量，持续观察队列、冲突、容量和错误；记录实际 RPO/RTO 与审计证据。

任何 identity 不匹配、state/data revision 不一致或 Restic 校验失败都应停止恢复，不允许通过重新批准所有客户端掩盖问题。

## 定期演练

每个 RC 至少在空 namespace 做一次恢复；GA 前必须在空集群完成。演练不得覆盖生产 PVC。结果需包含备份时间、目标恢复点、Hub ID、样本校验、实际 RPO/RTO、失败项和负责人签字。
