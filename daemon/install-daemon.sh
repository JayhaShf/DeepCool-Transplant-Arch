#!/usr/bin/env bash
# 安装/更新 deepcool-lm daemon；失败时恢复原有 binary/unit。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/bin

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/daemon/deepcool-lm-daemon.py"
UNIT="$ROOT/daemon/deepcool-lm-daemon.service"
BIN=/usr/local/bin/deepcool-lm-daemon
UNIT_PATH=/usr/lib/systemd/system/deepcool-lm-daemon.service

[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo bash $0" >&2; exit 1; }
[ -r "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }
[ -r "$UNIT" ] || { echo "找不到 $UNIT" >&2; exit 1; }
command -v pacman systemctl install groupadd usermod python3 >/dev/null
[ ! -L "$BIN" ] || { echo "拒绝覆盖符号链接 daemon: $BIN" >&2; exit 1; }
[ ! -L "$UNIT_PATH" ] || { echo "拒绝覆盖符号链接 unit: $UNIT_PATH" >&2; exit 1; }

echo "[1/5] 安装前静态校验"
python3 - "$SRC" <<'PY'
import ast, pathlib, sys
ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
PY
systemd-analyze verify "$UNIT"

echo "[2/5] 安装运行依赖"
pacman -S --needed --noconfirm python-pyusb python-psutil python-pillow

echo "[3/5] 配置 deepcool 访问组"
groupadd -f deepcool
INSTALL_USER="${SUDO_USER:-}"
if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != root ]; then
  usermod -aG deepcool "$INSTALL_USER"
  echo "  已将 $INSTALL_USER 加入 deepcool；新登录会话自动生效，run.sh 会为当前旧会话使用 newgrp。"
else
  echo "  未检测到桌面用户；稍后执行: sudo usermod -aG deepcool <用户名>"
fi

BACKUP_DIR="$(mktemp -d /tmp/deepcool-daemon-install.XXXXXX)"
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
    echo "安装失败，正在恢复原 daemon/unit…" >&2
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

echo "[4/5] 原子替换程序与 unit，并启动服务"
install -o root -g root -m 0755 "$SRC" "$BIN"
install -o root -g root -m 0644 "$UNIT" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable deepcool-lm-daemon.service
if [ "$WAS_ACTIVE" = 1 ]; then
  systemctl restart deepcool-lm-daemon.service
else
  systemctl start deepcool-lm-daemon.service
fi

echo "[5/5] 验证协议状态"
for _ in $(seq 1 50); do
  [ -S /run/deepcool-lm/deepcool-lm.sock ] && break
  sleep 0.1
done
systemctl is-active --quiet deepcool-lm-daemon.service
python3 - <<'PY'
import json, socket
path = "/run/deepcool-lm/deepcool-lm.sock"
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3)
s.connect(path)
s.sendall(b'{"action":"status"}')
s.shutdown(socket.SHUT_WR)
status = json.loads(s.recv(1 << 20))
if status.get("ok") is not True or status.get("daemon_online") is not True:
    raise SystemExit(f"daemon 协议自检失败: {status}")
print("daemon_online:", status["daemon_online"],
      "| device_connected:", status.get("device_connected"),
      "| workers_ok:", status.get("workers_ok"))
PY

SUCCESS=1
echo "安装完成。USB 可晚于服务出现；device_connected=false 时请检查线缆和 journal。"
