#!/bin/sh
set -eu

if [ "${1:-}" = "remove" ] || [ "${1:-}" = "0" ]; then
  systemctl disable --now kitesync.service 2>/dev/null || true
  getent passwd | while IFS=: read -r account _ uid _ _ home _; do
    wants="$home/.config/systemd/user/default.target.wants/kitesync.service"
    [ -L "$wants" ] || continue
    runtime="/run/user/$uid"
    if [ -d "$runtime" ]; then
      runuser -u "$account" -- env XDG_RUNTIME_DIR="$runtime" \
        systemctl --user disable --now kitesync.service 2>/dev/null || \
        systemctl --user --machine="${account}@.host" disable --now kitesync.service \
          2>/dev/null || \
        printf '%s\n' "警告：无法停止用户 $account 的 KiteSync 服务；请退出登录后再清理。" >&2
    fi
    rm -f "$wants"
  done
  rm -f /etc/systemd/user/default.target.wants/kitesync.service
  rm -f /etc/kitesync/system-service-enabled
fi
