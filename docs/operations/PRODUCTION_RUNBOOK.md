# 生产运行手册

## 前置条件

- Kubernetes 集群、支持 RWO 与 `VolumeSnapshot` 的 StorageClass/CSI Driver；
- 内部 DNS、Ingress、组织可信 CA，以及 cert-manager Issuer 或预创建 TLS Secret；
- S3 兼容存储；
- 生产数据库密码、Hub API Key、Cookie Secret、一次性 bootstrap token、Backup Controller token；
- 离线 Ed25519 更新公钥和三平台签名凭据。

生产默认单副本 Control Plane/Web、单 Hub StatefulSet、内置 PostgreSQL 和 Backup CronJob。若 `postgresql.internal=false`，必须提供 `postgresql.externalUrl`，并由外部数据库平台负责 WAL 归档与备份。

## 安装

先将机密写入受控 values 或外部 Secret 管理流程，不把生产 values 提交到版本库。安装前至少执行：

```bash
helm lint deploy/helm/kitesync -f production-values.yaml
helm template kitesync deploy/helm/kitesync -f production-values.yaml > rendered.yaml
kubectl apply --dry-run=server -f rendered.yaml
helm upgrade --install kitesync deploy/helm/kitesync \
  --namespace kitesync --create-namespace \
  -f production-values.yaml --atomic --timeout 20m
```

安装后验证 `/health/live`、`/health/ready`、`/version`、`/capabilities`，检查 Hub Agent mTLS、Hub Device ID、PVC 绑定、ServiceMonitor 和告警规则。通过内部 Ingress 443 暴露 Web/API；Syncthing TCP/UDP 22000 使用独立 Service，禁止暴露 Syncthing GUI/API。

## 首次初始化与升级

Helm 中的一次性 bootstrap token 只用于创建首个管理员，成功后数据库记录使其永久失效。立即轮换或移除 values 中的明文。

升级遵循：数据库备份成功 → `helm diff`/渲染验证 → 前向迁移 → readiness 通过 → 观察调和队列。迁移 checksum 变化会在构建门禁失败；迁移异常使新 Control Plane 不就绪，禁止继续流量。v1.0 不设计数据库降级迁移，回滚应用前必须确认 schema 向后兼容，否则从升级前备份恢复。

## 日常观察

重点指标包括 Hub up、调和队列/失败数、备份最近成功时间、空间配额和磁盘容量。出现配额超限时 Control Plane 暂停目标空间配置 mutation/同步，并在容量释放或管理员提高配额后恢复。设备吊销只有 Hub Desired State 已移除设备且 read-after 验证完成后才进入 `completed`。

## 事件处置

- Hub Pod 重建：确认 `state` 与 `data` PVC 未变化、Device ID 与事件 generation 正常；Worker 会在 cursor gap 时拉取完整 snapshot。
- Control Plane/Worker 崩溃：PostgreSQL 中任务由 `SKIP LOCKED` 重新领取，按稳定资源 ID 幂等重试。
- 数据库故障：停止新的业务 mutation，按照备份手册恢复 pgBackRest，再启动 Control Plane。
- Hub 数据损坏：暂停写入，选择同一 snapshot revision 的 state/data 恢复，验证 identity 后再解除 quiesce。
- 证书泄露或到期：先轮换 Hub Agent mTLS Secret 和客户端信任，再滚动 Agent/Control Plane；不得复用开发 CA。
