# 本机备份与恢复

KiteSync 没有中央 Backup Controller。每个节点应独立保护以下内容：

- KiteSync `state.json` 与本机 open secret；
- 整个 Syncthing home（尤其证书、key、`config.xml` 和索引）；
- 用户选择的同步目录及 `.stversions`（如果需要恢复历史版本）。

备份前暂停 KiteSync 服务或使用支持一致快照的文件系统。恢复时先停止服务，将状态恢复到原
平台数据目录并确保 owner/权限正确，再启动服务。恢复证书和 key 才能保持原 Device ID；仅恢复
同步目录但生成新身份时，所有 peers 都必须重新批准设备。

不要把版本历史等同于备份：删除、损坏或勒索软件变更可能同步到所有 peers，30 天 staggered
history 也受各节点磁盘空间影响。重要数据仍需独立、离线或不可变备份。

恢复后如果只是忘记管理密码，使用 `kitesync password reset`（system node 使用 `--system`）
即可；不要删除 `state.json` 或 Syncthing home。密码恢复只更新认证哈希并撤销会话，不改变证书、
Device ID、配对、folder ID、同步目录或 `.stversions`。迁移同步目录时也应先在界面暂停并手动
移动内容，再选择新位置；KiteSync 不会替用户移动、覆盖或删除数据。
