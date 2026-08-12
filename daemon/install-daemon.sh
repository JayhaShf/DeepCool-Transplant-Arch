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

echo "[1/5] 安装依赖（python-pyusb python-psutil python-pillow）"
pacman -S --needed --noconfirm python-pyusb python-psutil python-pillow

echo "[2/5] 创建 deepcool 用户组（socket 0660 访问控制）"
groupadd -f deepcool
INSTALL_USER="${SUDO_USER:-}"
if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ]; then
  usermod -aG deepcool "$INSTALL_USER"
  echo "  已将用户 $INSTALL_USER 加入 deepcool 组"
else
  echo "  未检测到 SUDO_USER；请手动将桌面用户加入组："
  echo "    sudo usermod -aG deepcool <你的用户名>"
fi
echo "  说明: usermod 后「当前已登录会话」的 id/groups 不会出现 deepcool，"
echo "        直到注销重登。daemon 会用 setfacl 按用户 ACL 授权，无需重登也能连。"
# 确保 acl 工具可用（setfacl）
pacman -S --needed --noconfirm acl >/dev/null 2>&1 || true

echo "[3/5] 安装 daemon 与 systemd unit"
install -m 0755 "$SRC" "$BIN"
install -m 0644 "$UNIT" "$UNIT_DIR/deepcool-lm-daemon.service"

echo "[4/5] 启用并启动服务"
systemctl daemon-reload
systemctl stop deepcool-lm-daemon.service 2>/dev/null || true
systemctl enable --now deepcool-lm-daemon.service
sleep 2
# 双保险：安装用户 ACL（daemon 启动时也会写组成员 ACL）
if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ] && [ -S /run/deepcool-lm/deepcool-lm.sock ]; then
  setfacl -m "u:${INSTALL_USER}:rw" /run/deepcool-lm/deepcool-lm.sock 2>/dev/null || true
fi

echo "[5/5] 验证"
echo
echo "===== 验证 ====="
systemctl is-active deepcool-lm-daemon.service
command ls -la /run/deepcool-lm/deepcool-lm.sock
getfacl -p /run/deepcool-lm/deepcool-lm.sock 2>/dev/null | head -20 || true
python3 - <<'PY'
import socket, json, os, grp
path = "/run/deepcool-lm/deepcool-lm.sock"
st = os.stat(path)
mode = st.st_mode & 0o777
try:
    gname = grp.getgrgid(st.st_gid).gr_name
except KeyError:
    gname = str(st.st_gid)
print(f"socket mode: {oct(mode)} group: {gname}")
if mode != 0o660:
    print("警告: 期望 mode 0o660")
if gname != "deepcool":
    print("警告: 期望 group deepcool")
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
if [ -n "${INSTALL_USER:-}" ] && [ "$INSTALL_USER" != "root" ]; then
  echo
  echo "用户 $INSTALL_USER 已在 deepcool 组（groups $INSTALL_USER 可见）。"
  echo "当前图形会话若登录早于加组，id 仍可能没有 deepcool —— 这是正常的，"
  echo "不必强求 id 出现该组；socket ACL 已按 UID 授权。"
  echo "若希望 id 也显示 deepcool：注销并重新登录即可。"
fi
echo "完成。"
