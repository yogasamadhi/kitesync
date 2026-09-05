# 发布手册

正式发布构建一个 Bun 编译主程序和固定源码构建的 Syncthing sidecar，再由各平台原生 runner
生成安装包。Bun 构建必须使用 ESM、minify、compile，显式关闭 `autoloadDotenv` 与
`autoloadBunfig`，不启用 bytecode。

支持矩阵：

| 平台      | 架构         | 交付物                                          |
| --------- | ------------ | ----------------------------------------------- |
| Windows   | x64          | 签名 NSIS `.exe`                                |
| macOS 13+ | x64、arm64   | `/Applications/KiteSync.app` + 签名/公证 `.pkg` |
| Linux     | x64、arm64   | `.deb`、`.rpm`                                  |
| OCI       | amd64、arm64 | 可选单 Node 镜像                                |

## 签名顺序

1. 从固定 submodule 与固定 Go toolchain 构建并验证 Syncthing；
2. 编译 KiteSync 主程序并在无仓库/无 node_modules 目录做启动 smoke；
3. Windows 签 `kitesync.exe`、`syncthing.exe`，再签 NSIS installer；
4. macOS 分别签 Bun agent（仅它带 JIT entitlements）、Syncthing、Swift launcher 和 app bundle；
5. 签 installer，notarize 并 staple；
6. 生成校验和、SBOM 和来源说明后发布。

macOS 两种架构必须在 Xcode 原生 runner 上以 CGO 开启、
`MACOSX_DEPLOYMENT_TARGET=13.0` 构建。缓存键和 `SYNCTHING_BUILD.json` 必须包含该策略；使用
`otool -l` 核对最终 sidecar 的 `LC_BUILD_VERSION minos 13.0`。Windows/Linux 继续使用各自目标
的关闭 CGO 策略。

跨平台 compile 可以用于预检，但正式签名、公证、installer 构建和 smoke 必须在目标平台的原生
runner 上完成。

正式 tag workflow 要求配置 Windows PFX 的 base64 内容与密码
（`WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD`），以及 macOS Developer ID 证书、应用/
安装器 identity 和 notarization 凭据（`MACOS_CSC_LINK`、`MACOS_CSC_KEY_PASSWORD`、
`MACOS_APPLICATION_IDENTITY`、`MACOS_INSTALLER_IDENTITY`、`APPLE_ID`、
`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）。缺少凭据时对应平台必须失败，不发布未签名的
Windows/macOS 安装包。Linux 包由 GitHub Release 的 `SHA256SUMS` 覆盖。

tag workflow 会先在独立 Linux gate 中从 frozen lockfile 完成静态检查、单元测试、固定源码
Syncthing 构建验证、无 Docker 双节点 integration、Web E2E 和 standalone compile smoke。只有
该 gate 成功后，平台安装包与可选 OCI 镜像才会并行构建。GitHub Release 同时包含 CycloneDX
SBOM、`SYNCTHING_SOURCE.json` 和覆盖全部安装包及元数据文件的 `SHA256SUMS`。
每个平台随包的 `SYNCTHING_BUILD.json` 同时记录源码构建产物（签名前）的
`sourceBuildSha256` 和代码签名后的 `distributedSha256`；Windows/macOS 验证安装内容时应使用
后者，不能拿签名前 hash 比较已签名 sidecar。

安装包矩阵会在每个原生平台重新执行静态与单元门禁。Windows smoke 覆盖签名、计划任务、
Private Network 防火墙、原地覆盖安装和卸载后身份保留；macOS smoke 从已安装 app bundle 启动
真实服务并验证身份；Linux smoke 覆盖 deb 的 system service、原地升级与卸载，并在 Rocky Linux
容器中实际安装 rpm。系统级 UI（UAC、Gatekeeper 登录项批准）仍由发布验收人员在真实桌面会话
中确认。

下载后可在 Linux 上验证：

```bash
sha256sum --check SHA256SUMS
```

## 发布门禁

- `bun run check`、build、非 Docker integration 和 Web E2E 全部通过；
- migration legacy checksum、依赖许可证、Syncthing commit/tree/module/hash 门禁通过；
- 干净 Windows、macOS、Linux 环境没有 Bun/Node/Docker 仍能安装、双击、后台启动；
- 覆盖升级保持 Device ID、folders 和设置；默认卸载保留数据；
- Windows Authenticode、Private profile 防火墙和任务失败重启验证通过；
- macOS Gatekeeper、SMAppService、hardened runtime、公证和 staple 验证通过；
- macOS x64/arm64 均在不调用 scan API 的条件下验证新增、修改和删除文件能被 watcher 自动同步；
- Linux user/system service 互斥及升级验证通过；
- 两台不同平台节点在无中心服务、global discovery 和 Relay 时完成发现/静态地址配对与同步；
- 文件 API 的 traversal、编码、symlink/junction、隐藏元数据、分页、Range 和鉴权测试通过；
- 可选 OCI amd64/arm64 镜像分别在原生 runner 完成只读 rootfs 启动、嵌入 UI 与身份持久化重启
  smoke；LAN 配对仍在部署验收中验证。
