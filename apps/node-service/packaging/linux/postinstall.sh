#!/bin/sh
set -eu

if ! getent group kitesync >/dev/null 2>&1; then
  groupadd --system kitesync 2>/dev/null || addgroup --system kitesync
fi
if ! getent passwd kitesync >/dev/null 2>&1; then
  useradd --system --gid kitesync --home-dir /var/lib/kitesync --shell /usr/sbin/nologin kitesync 2>/dev/null \
    || adduser --system --ingroup kitesync --home /var/lib/kitesync --no-create-home kitesync
fi
# Create the state root explicitly: relying on install(1) to create an implicit parent leaves
# /var/lib/kitesync owned by root on a first install. -d only adjusts these two directories and
# never recursively changes ownership of existing state or synchronized data during upgrades.
install -d -o kitesync -g kitesync -m 0750 /var/lib/kitesync
install -d -o kitesync -g kitesync -m 0750 /var/lib/kitesync/data
systemctl daemon-reload 2>/dev/null || true
if systemctl is-active --quiet kitesync.service 2>/dev/null; then
  systemctl restart kitesync.service
fi

printf '%s\n' \
  'KiteSync 未自动修改主机防火墙。局域网直连通常需要放行：' \
  '  TCP/UDP 22000（同步），UDP 21027（局域网发现）' \
  '  可选 TCP 3210（远程管理 UI；请仅允许受信任的局域网网段）' \
  'ufw 示例：' \
  '  sudo ufw allow 22000/tcp' \
  '  sudo ufw allow 22000/udp' \
  '  sudo ufw allow 21027/udp' \
  '  sudo ufw allow from 192.168.0.0/16 to any port 3210 proto tcp  # 可选 UI 示例' \
  'firewalld 示例：' \
  '  sudo firewall-cmd --permanent --add-port=22000/tcp --add-port=22000/udp --add-port=21027/udp' \
  '  sudo firewall-cmd --permanent --zone=home --add-port=3210/tcp  # 可选 UI' \
  '  sudo firewall-cmd --reload' \
  '若当前用户已启用桌面后台服务，升级后请运行 systemctl --user restart kitesync.service。' \
  '若 Syncthing 因端口冲突改用动态端口，请以 KiteSync 管理页显示的实际端口为准。'
