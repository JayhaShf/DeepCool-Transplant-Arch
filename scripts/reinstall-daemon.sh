#!/usr/bin/env bash
# 彻底重装：卸载全部 deepcool-* 包 → 从当前编译完成的 deepcool-lm-rust 包重新安装
# 用法: sudo ./scripts/reinstall-daemon.sh   （脚本内所有 pacman/systemctl 均需 root）
set -euo pipefail

# daemon 源码仓库位置：可用环境变量 DEEPCOOL_LINUX_REPO 指定，否则自动探测
REPO="${DEEPCOOL_LINUX_REPO:-}"
if [ -z "$REPO" ]; then
  for cand in "$HOME/Git/DeepCool-linux" "$HOME/git/DeepCool-linux" "$HOME/src/DeepCool-linux"; do
    [ -f "$cand/packaging/deepcool-lm-rust/deepcool-lm-rust-1.1.0-1-x86_64.pkg.tar.zst" ] && REPO="$cand" && break
  done
fi
PKG="${DEEPCOOL_LINUX_PKG:-$REPO/packaging/deepcool-lm-rust/deepcool-lm-rust-1.1.0-1-x86_64.pkg.tar.zst}"
[ -n "$REPO" ] || { echo "找不到 DeepCool-linux 仓库，请设置 DEEPCOOL_LINUX_REPO" >&2; exit 1; }
[ -f "$PKG" ] || { echo "找不到编译好的包: $PKG" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo $0" >&2; exit 1; }

echo "[1/6] 停止 deepcool 相关服务"
systemctl stop deepcool-lm-daemon.service deepcool-lm-web.service deepcool-lm.socket 2>/dev/null || true

echo "[2/6] 卸载全部 deepcool-* 包"
mapfile -t PKGS < <(pacman -Qq 2>/dev/null | grep -i '^deepcool' || true)
if [ "${#PKGS[@]}" -gt 0 ]; then
  pacman -Rns --noconfirm "${PKGS[@]}"
else
  echo "  （当前没有已安装的 deepcool-* 包）"
fi

echo "[3/6] 确认卸载结果"
if pacman -Qq 2>/dev/null | grep -qi '^deepcool'; then
  echo "  !! 仍有 deepcool 包残留:"; pacman -Qq | grep -i '^deepcool' >&2
  exit 1
fi
echo "  OK：无 deepcool-* 包"

echo "[4/6] 安装当前编译完成的包: $PKG"
pacman -U --noconfirm "$PKG"

echo "[5/6] 启用并启动服务"
systemctl enable --now deepcool-lm.socket deepcool-lm-daemon.service deepcool-lm-web.service

echo "[6/7] 当前用户加入 deepcool 组"
USER_NAME="${SUDO_USER:-$USER}"
gpasswd -a "$USER_NAME" deepcool 2>/dev/null || true

echo "[7/7] 关闭 daemon 原生渲染（仅保留当前项目推送）"
for i in $(seq 1 15); do
  if curl -fsS --max-time 2 http://127.0.0.1:8642/api/status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/disable-native-render.sh" || echo "  !! 应用配置失败（可稍后手动运行 scripts/disable-native-render.sh）"

echo
echo "===== 验证 ====="
sleep 2
systemctl is-active deepcool-lm-daemon.service deepcool-lm-web.service deepcool-lm.socket
pacman -Q deepcool-lm-rust
ls -l /run/deepcool-lm/deepcool-lm.sock
echo "完成。"
