# Syncthing 上游源码

`upstream/` 是 `https://github.com/syncthing/syncthing.git` 的只读 Git submodule，固定在
`v2.1.3` / `946e2b83a1f6c6ae119427c09e0a5802940b82ff`。不要直接修改 submodule；版本、提交、
Git tree、许可证和构建参数记录在 `UPSTREAM.json`。

KiteSync 不再下载 Syncthing 官方预编译包。`bun run syncthing:build` 使用 Go 1.26、上游
`build.go`、只读 module 模式和固定构建元数据生成当前平台的 Node sidecar。构建禁用
Syncthing 内置自更新，并使用上游支持的纯 Go SQLite 实现，正式安装包随后由 KiteSync
发布流水线完成平台代码签名。

生成文件位于 `vendor/syncthing/bin/<platform>-<arch>/`，不纳入 Git。`GO_MODULES.json`
记录五个发布目标实际链接依赖的并集、版本、replacement、许可证与原文哈希；
`SYNCTHING_THIRD_PARTY_LICENSES.txt` 携带这些模块根目录中完整的 LICENSE、COPYING、
NOTICE 和 COPYRIGHT 原文。更新固定源码后运行 `bun run licenses:generate`，随后必须通过
`bun run licenses:check`。安装包同时携带以上文件、`NOTICE.kitesync.txt` 和上游
MPL-2.0 `LICENSE`。
