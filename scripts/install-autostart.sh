#!/usr/bin/env bash
# 开机自启 + 后台运行（登录后自动以隐藏窗口/托盘方式启动 DeepCool Linux Port）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
BIN="$HOME/.local/bin/deepcool-official-linux"
DESKTOP="$AUTOSTART_DIR/deepcool-official-linux.desktop"

mkdir -p "$AUTOSTART_DIR"
# Keep the stable user wrapper in the desktop entry. It selects the installed
# /opt runtime when available and falls back to the source checkout otherwise.
desktop_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}
EXEC_BIN="$(desktop_escape "$BIN")"
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port) Autostart
Name[zh_CN]=DeepCool（Linux 移植版）开机自启
Comment=Start DeepCool official UI in background (tray) at login
Exec=$EXEC_BIN --hidden
Icon=deepcool-official-linux
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
StartupNotify=false
DESK
chmod 0644 "$DESKTOP"

echo "已安装开机自启（后台/托盘模式）："
echo "  $DESKTOP"
echo
echo "说明："
echo "  登录后 DeepCool 会在后台启动（窗口隐藏，系统托盘有图标），"
echo "  LCD 渲染/推帧继续运行；点击托盘图标可显示/隐藏主界面。"
echo "  如需立即以后台模式启动一次："
echo "    deepcool-official-linux --hidden"
