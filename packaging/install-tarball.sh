#!/usr/bin/env bash
# 把自包含 tar（deepcool-linux-port-*.tar.zst）安装到 /opt，并装好 daemon/菜单。
# 用法：
#   tar --zstd -xf deepcool-linux-port-0.1.0.tar.zst -C /tmp/dc
#   sudo bash /tmp/dc/deepcool-linux-port-0.1.0/packaging/install-tarball.sh /tmp/dc/deepcool-linux-port-0.1.0
# 可选：--autostart（登录后后台/托盘自启）
set -euo pipefail

SRC="${1:?用法: install-tarball.sh <解压目录> [--autostart]}"
AUTOSTART=0
if [ "${2:-}" = "--autostart" ]; then AUTOSTART=1; fi
SRC="$(cd "$SRC" && pwd)"
PREFIX="/opt/deepcool-linux-port"

[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行" >&2; exit 1; }
[ -d "$SRC/app/resources/app.asar.extracted" ] || { echo "不是有效解压目录: $SRC" >&2; exit 1; }
[ -x "$SRC/electron/electron" ] || { echo "缺少 $SRC/electron/electron" >&2; exit 1; }

echo "== [1/5] 安装应用与运行库到 $PREFIX =="
rm -rf "$PREFIX"
install -d "$PREFIX"
cp -a "$SRC/app" "$PREFIX/app"
cp -a "$SRC/electron" "$PREFIX/electron"
cp -a "$SRC/scripts" "$PREFIX/scripts"
cp -a "$SRC/patches" "$PREFIX/patches"
cp -a "$SRC/daemon" "$PREFIX/daemon"
cp -a "$SRC/tools" "$PREFIX/tools"
cp -a "$SRC/bin" "$PREFIX/bin"
cp "$SRC/README.md" "$PREFIX/README.md" 2>/dev/null || true
chmod +x "$PREFIX/bin/deepcool-linux-port"

echo "== [2/5] 安装 daemon（pyusb/psutil/pillow + deepcool 组 + systemd + ACL）=="
bash "$PREFIX/daemon/install-daemon.sh"

echo "== [3/5] 系统命令与桌面入口 =="
install -Dm755 "$PREFIX/bin/deepcool-linux-port" /usr/bin/deepcool-linux-port
install -d /usr/share/applications /usr/share/icons/hicolor/256x256/apps
if [ -f "$PREFIX/app/resources/app.asar.extracted/resources/icon.png" ]; then
  install -m0644 "$PREFIX/app/resources/app.asar.extracted/resources/icon.png" \
    /usr/share/icons/hicolor/256x256/apps/deepcool-linux-port.png
fi
cat > /usr/share/applications/deepcool-linux-port.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port)
Name[zh_CN]=DeepCool（Linux 移植版）
Comment=DeepCool 1.2.12 official UI with Arch Linux sensor and LM-Series bridge
Exec=/usr/bin/deepcool-linux-port
Icon=deepcool-linux-port
Terminal=false
StartupNotify=true
Categories=Settings;HardwareSettings;
StartupWMClass=DeepCool
EOF
command -v update-desktop-database >/dev/null && update-desktop-database /usr/share/applications || true

echo "== [4/5] 自启（可选）=="
if [ "$AUTOSTART" = 1 ]; then
  mkdir -p "$HOME/.config/autostart"
  cat > "$HOME/.config/autostart/deepcool-official-linux.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port) Autostart
Name[zh_CN]=DeepCool（Linux 移植版）开机自启
Comment=Start DeepCool official UI in background (tray) at login
Exec=/usr/bin/deepcool-linux-port --hidden
Icon=deepcool-linux-port
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
StartupNotify=false
EOF
  chmod 0644 "$HOME/.config/autostart/deepcool-official-linux.desktop"
  echo "已启用开机自启"
else
  echo "跳过自启（加 --autostart 启用）"
fi

echo "== [5/5] 校验 =="
systemctl is-active deepcool-lm-daemon.service
ls -l /run/deepcool-lm/deepcool-lm.sock
getent group deepcool
echo
echo "完成。启动：deepcool-linux-port"
echo "若 LCD 无画面：sudo systemctl restart deepcool-lm-daemon"
echo "组权限提示：重新登录后 groups \"\$USER\" 应含 deepcool。"
