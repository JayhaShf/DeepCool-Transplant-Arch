#!/usr/bin/env bash
# 带预检与失败恢复的 deepcool-lm daemon 重装。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/bin

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$ROOT/daemon/install-daemon.sh"
DAEMON_SRC="$ROOT/daemon/deepcool-lm-daemon.py"
UNIT_SRC="$ROOT/daemon/deepcool-lm-daemon.service"
BIN=/usr/local/bin/deepcool-lm-daemon
UNIT_PATH=/usr/lib/systemd/system/deepcool-lm-daemon.service
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo $0" >&2; exit 1; }
[ ! -L "$BIN" ] || { echo "拒绝覆盖符号链接 daemon: $BIN" >&2; exit 1; }
[ ! -L "$UNIT_PATH" ] || { echo "拒绝覆盖符号链接 unit: $UNIT_PATH" >&2; exit 1; }

REMOVE_OLD_PACKAGES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remove-old-packages) REMOVE_OLD_PACKAGES=1; shift ;;
    -h|--help)
      echo "用法: sudo $0 [--remove-old-packages]"
      echo "默认只停用旧服务并覆盖 daemon；删除旧 pacman 包必须显式指定该选项。"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

echo "[预检] 确认安装源、脚本和 unit 可用"
[ -r "$INSTALLER" ] && [ -r "$DAEMON_SRC" ] && [ -r "$UNIT_SRC" ]
bash -n "$INSTALLER" "$ROOT/scripts/disable-native-render.sh"
python3 - "$DAEMON_SRC" <<'PY'
import ast, pathlib, sys
ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
PY
systemd-analyze verify "$UNIT_SRC"

BACKUP_DIR="$(mktemp -d /tmp/deepcool-daemon-reinstall.XXXXXX)"
HAD_BIN=0
HAD_UNIT=0
WAS_ACTIVE=0
WAS_ENABLED=0
SUCCESS=0
[ -e "$BIN" ] && { cp -a -- "$BIN" "$BACKUP_DIR/daemon"; HAD_BIN=1; }
[ -e "$UNIT_PATH" ] && { cp -a -- "$UNIT_PATH" "$BACKUP_DIR/unit"; HAD_UNIT=1; }
systemctl is-active --quiet deepcool-lm-daemon.service && WAS_ACTIVE=1 || true
systemctl is-enabled --quiet deepcool-lm-daemon.service && WAS_ENABLED=1 || true

finish() {
  rc=$?
  trap - EXIT
  if [ "$SUCCESS" != 1 ]; then
    set +e
    echo "重装失败，正在恢复开始前的 daemon/unit…" >&2
    if [ "$HAD_BIN" = 1 ]; then cp -a -- "$BACKUP_DIR/daemon" "$BIN"; else rm -f -- "$BIN"; fi
    if [ "$HAD_UNIT" = 1 ]; then cp -a -- "$BACKUP_DIR/unit" "$UNIT_PATH"; else rm -f -- "$UNIT_PATH"; fi
    systemctl daemon-reload
    if [ "$WAS_ENABLED" = 1 ]; then systemctl enable deepcool-lm-daemon.service; else systemctl disable deepcool-lm-daemon.service; fi
    if [ "$WAS_ACTIVE" = 1 ]; then systemctl restart deepcool-lm-daemon.service; else systemctl stop deepcool-lm-daemon.service; fi
  fi
  rm -rf -- "$BACKUP_DIR"
  exit "$rc"
}
trap finish EXIT

echo "[1/3] 停止当前服务并禁用已知旧服务"
systemctl stop deepcool-lm-daemon.service 2>/dev/null || true
systemctl disable --now deepcool-lm-web.service deepcool-lm.socket 2>/dev/null || true
mapfile -t PKGS < <(pacman -Qq 2>/dev/null | grep -iE '^(deepcool-lm-rust|deepcool-lm-web|deepcool-lm-daemon|deepcool-lm)$' || true)
if [ "${#PKGS[@]}" -gt 0 ]; then
  if [ "$REMOVE_OLD_PACKAGES" = 1 ]; then
    echo "  显式请求删除旧软件包: ${PKGS[*]}"
    pacman -Rns --noconfirm "${PKGS[@]}"
  else
    echo "  保留旧软件包（如需删除请显式传入 --remove-old-packages）: ${PKGS[*]}"
  fi
else
  echo "  （没有匹配的旧软件包）"
fi

echo "[2/3] 通过 bash 安装已预检的 Python daemon"
bash "$INSTALLER"

echo "[3/3] 写入旧 Rust daemon 的黑屏兼容配置"
bash "$ROOT/scripts/disable-native-render.sh" || echo "  !! 兼容配置写入失败；Python daemon 不受影响"

systemctl is-active --quiet deepcool-lm-daemon.service
[ -S /run/deepcool-lm/deepcool-lm.sock ]
SUCCESS=1
echo "重装完成。"
