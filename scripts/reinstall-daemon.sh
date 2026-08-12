#!/usr/bin/env bash
# 彻底重装 deepcool-lm daemon（Python 重写版，源码在本仓库 daemon/ 目录）
# 用法: sudo ./scripts/reinstall-daemon.sh   （脚本内所有 pacman/systemctl 均需 root）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo $0" >&2; exit 1; }

echo "[1/3] 停止并卸载旧 deepcool-* 包（如有残留，仅精确匹配已知包名）"
systemctl stop deepcool-lm-daemon.service deepcool-lm-web.service deepcool-lm.socket 2>/dev/null || true
mapfile -t PKGS < <(pacman -Qq 2>/dev/null | grep -iE '^(deepcool-lm-rust|deepcool-lm-web|deepcool-lm-daemon|deepcool-lm)$' || true)
if [ "${#PKGS[@]}" -gt 0 ]; then
  pacman -Rns --noconfirm "${PKGS[@]}"
else
  echo "  （当前没有已安装的 deepcool-* 包）"
fi

echo "[2/3] 安装 Python daemon（依赖 + deepcool 组 + systemd unit）"
"$ROOT/daemon/install-daemon.sh"

echo "[3/3] 禁用原生渲染占位（Python daemon 无原生渲染，LCD 内容完全由移植层推帧）"
"$ROOT/scripts/disable-native-render.sh" || echo "  !! 写 lcd.json 占位失败（可忽略，不影响 Python daemon）"

echo
echo "===== 验证 ====="
systemctl is-active deepcool-lm-daemon.service
ls -l /run/deepcool-lm/deepcool-lm.sock
echo "完成。"
