#!/usr/bin/env bash
# 安装/重装 deepcool-lm daemon（Python 重写版，源码在本仓库 daemon/ 目录）
# 用法: sudo bash daemon/install-daemon.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/daemon/deepcool-lm-daemon.py"
UNIT="$ROOT/daemon/deepcool-lm-daemon.service"
BIN="/usr/local/bin/deepcool-lm-daemon"
UNIT_DIR="/usr/lib/systemd/system"
[ -f "$SRC" ] || { echo "找不到 $SRC" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo $0" >&2; exit 1; }

echo "[1/4] 安装依赖（python-pyusb python-psutil python-pillow）"
pacman -S --needed --noconfirm python-pyusb python-psutil python-pillow

echo "[2/4] 安装 daemon 与 systemd unit"
install -m 0755 "$SRC" "$BIN"
install -m 0644 "$UNIT" "$UNIT_DIR/deepcool-lm-daemon.service"

echo "[3/4] 用户组说明"
# 说明：Python daemon 的 socket 权限是 0666（任何本地用户可连接），
# 不再需要 deepcool 用户组（原 Rust 包创建，重装系统后已不存在）。

echo "[4/4] 启用并启动服务"
systemctl daemon-reload
systemctl stop deepcool-lm-daemon.service 2>/dev/null || true
systemctl enable --now deepcool-lm-daemon.service
sleep 2

echo
echo "===== 验证 ====="
systemctl is-active deepcool-lm-daemon.service
ls -l /run/deepcool-lm/deepcool-lm.sock
python3 - "$BIN" <<'PY'
import sys, socket, json
path = "/run/deepcool-lm/deepcool-lm.sock"
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(path)
s.sendall(json.dumps({"action": "status"}).encode())
s.shutdown(socket.SHUT_WR)
data = b""
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    data += chunk
status = json.loads(data)
snap = status.get("snapshot", {})
print("ok:", status.get("ok"), "| mode:", status.get("mode"))
print("cpu_temp:", snap.get("cpu_temp"), "cpu_usage:", snap.get("cpu_usage"),
      "cpu_freq(GHz):", snap.get("cpu_freq"), "cpu_power(W):", snap.get("cpu_power"))
print("gpu_temp:", snap.get("gpu_temp"), "mem_percent:", snap.get("mem_percent"),
      "disks:", len(snap.get("disks", [])), "nets:", len(snap.get("nets", [])))
PY
echo "完成。"
