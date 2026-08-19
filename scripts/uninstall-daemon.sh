#!/usr/bin/env bash
# 移除系统级 daemon。--purge 额外删除兼容配置和专用用户组。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/bin

PURGE=0
case "${1:-}" in
  "") ;;
  --purge) PURGE=1 ;;
  *) echo "用法: sudo bash $0 [--purge]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "用法: sudo bash $0 [--purge]" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo bash $0" >&2; exit 1; }

systemctl disable --now deepcool-lm-daemon.service 2>/dev/null || true
rm -f -- /usr/local/bin/deepcool-lm-daemon
rm -f -- /usr/lib/systemd/system/deepcool-lm-daemon.service
systemctl daemon-reload
systemctl reset-failed deepcool-lm-daemon.service 2>/dev/null || true

rm -f -- /var/lib/deepcool-lm/reset-state.json
rmdir -- /var/lib/deepcool-lm /run/deepcool-lm 2>/dev/null || true

if [ "$PURGE" = 1 ]; then
  rm -f -- /etc/deepcool-lm/lcd.json
  rmdir -- /etc/deepcool-lm 2>/dev/null || true
  if getent group deepcool >/dev/null 2>&1; then
    groupdel deepcool || echo "警告: deepcool 组仍在使用，未删除" >&2
  fi
fi

echo "deepcool-lm daemon 已卸载。Python 依赖可能被其他程序共享，未自动删除。"
[ "$PURGE" = 1 ] || echo "保留了 /etc/deepcool-lm 配置和 deepcool 组；需要彻底清理时使用 --purge。"
