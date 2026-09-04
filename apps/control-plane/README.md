# Legacy PostgreSQL migrations

此目录不再是应用或 workspace。`migrations/` 仅保存旧中心化版本的不可变 PostgreSQL schema，
便于审计和旧部署人工导出；KiteSync P2P Node 不运行这些 migration，也不读取旧数据库。

已有 SQL 文件不得修改，完整性由 `bun run migrations:check` 验证。
