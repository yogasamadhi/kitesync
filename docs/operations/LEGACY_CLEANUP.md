# 旧中心部署人工清理

本版本不会读取或迁移旧 PostgreSQL 中的用户、共享、审计、配额和邀请，也不会自动删除旧
PostgreSQL、MinIO、Hub、FileBrowser 或 Controller volumes。升级桌面节点时会保留原有
Syncthing home 和 folder 配置，旧 Hub 的 Device ID 可以继续作为普通 peer 使用。

建议先完成以下验证：

1. 在所有需要保留的节点导出旧服务的 volume 清单和离线备份；
2. 安装新 Node 并确认 Device ID 未变化；
3. 在管理页检查所有 folders、peers、同步模式和版本策略；
4. 让每个重要 folder 完成一次全量扫描并确认 `Up to Date`；
5. 单独导出法规或运营要求保留的旧账户/审计数据；
6. 停止旧 Compose/集群至少一个观察周期，再人工删除资源。

旧客户端 SQLite 文件不再读取，但不会被安装器删除。确认不需要回滚后，可从旧应用数据目录
人工移走。任何清理命令都应使用部署时的准确项目名和 volume 名；本文不提供通配符删除命令，
避免误删其他 Docker 数据。

`apps/control-plane/migrations` 仅作为不可变 legacy schema 记录保留，并由 checksum 门禁防止
历史内容被改写；它不在 workspace、构建、镜像或运行路径中。
