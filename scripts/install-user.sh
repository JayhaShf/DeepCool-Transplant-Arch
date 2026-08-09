#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

cat > "$BIN_DIR/deepcool-official-linux" <<SH
#!/usr/bin/env bash
exec "$ROOT/scripts/run.sh" "\$@"
SH
chmod +x "$BIN_DIR/deepcool-official-linux"

ICON_SOURCE="$ROOT/work/windows-app/resources/app.asar.extracted/resources/icon.png"
if [ -f "$ICON_SOURCE" ]; then cp "$ICON_SOURCE" "$ICON_DIR/deepcool-official-linux.png"; fi
cat > "$APP_DIR/deepcool-official-linux.desktop" <<EOF2
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port)
Name[zh_CN]=DeepCool（Linux 移植版）
Comment=DeepCool 1.2.12 official UI with Arch Linux sensor and LM-Series bridge
Exec=$BIN_DIR/deepcool-official-linux
Icon=deepcool-official-linux
Terminal=false
StartupNotify=true
Categories=Settings;HardwareSettings;
StartupWMClass=DeepCool
EOF2
chmod 0644 "$APP_DIR/deepcool-official-linux.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$APP_DIR" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo "已安装："
echo "  命令: $BIN_DIR/deepcool-official-linux"
echo "  菜单: DeepCool（Linux 移植版）"
