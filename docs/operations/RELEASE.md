# v1.0 发布手册

## 发布输入

Release workflow 构建 Control Plane、Web、Hub Agent、Backup Controller 和 PostgreSQL/pgBackRest 的 `linux/amd64`、`linux/arm64` OCI 镜像，并生成 SBOM/provenance。桌面矩阵构建 Windows x64、macOS x64/arm64、Linux x64。

必须在 CI Secret 中配置 Windows 代码签名证书、Apple Developer ID/公证凭据、Linux GPG 私钥和 `KITESYNC_UPDATE_PUBLIC_KEY_PEM`。workflow 在凭据缺失时失败，不允许产出“正式”未签名安装包。流水线会用该公钥覆盖仓库内仅供开发构建使用的占位公钥。

## 更新清单

更新签名私钥保持离线，不上传 CI。发布操作者先生成包含版本、minimumClientVersion、平台 URL 与 SHA-512 的规范 JSON，再执行：

```bash
KITESYNC_UPDATE_PRIVATE_KEY_FILE=/secure/offline-update-key.pem \
  bun run updates:sign -- unsigned-manifest.json signed-manifest.json
```

将签名清单与安装包上传 S3，使用 Control Plane Admin API 发布 stable channel。Control Plane 用 Helm Secret 中的 Ed25519 公钥验签；桌面端再校验清单签名、SHA-512 和平台代码签名。低于 `minimumClientVersion` 的客户端禁止新配置 mutation，但既有 Syncthing 文件同步继续。

未签名清单固定使用以下结构；`platform` 使用 Node 平台名 `win32`、`darwin`、`linux`，`arch` 使用 `x64` 或 `arm64`。签名脚本读取 `path` 计算 SHA-512，并在签名输出中移除本地路径：

```json
{
  "version": "1.0.0",
  "channel": "stable",
  "minimumClientVersion": "1.0.0",
  "assets": [
    {
      "platform": "darwin",
      "arch": "arm64",
      "url": "https://updates.example/KiteSync-1.0.0-arm64.dmg",
      "path": "apps/desktop/release/KiteSync-1.0.0-arm64.dmg"
    }
  ]
}
```

## 发布门禁

- `bun run check`、build、integration、E2E、license 和 migration checksum 全部通过；
- 五个 OCI 镜像在 amd64/arm64 可启动，PostgreSQL 镜像仍报告 major 17；
- Helm lint、server dry-run、NetworkPolicy/RBAC、升级和回滚预演通过；
- Windows 签名验证、macOS `codesign`/notarization/staple、Linux GPG/Ed25519 验证通过；
- Syncthing v2.1.3 的官方 PGP、SHA-256、实际版本和每个平台架构通过；
- 空集群恢复、30 台设备 7 天 soak 和目标容量测试通过。

只有上述证据归档完成后才能标记 GA。Alpha 只使用 Compose；Beta 首次进入 K8s；RC 冻结 API v1、schema v1 与 Helm values schema。
