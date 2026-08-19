#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"

BIN_SCRIPT="$BIN_DIR/deepcool-official-linux"
{
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  # Prefer the validated system install when present. The source checkout is
  # only a fallback for development; its Electron binary may not be present.
  printf '%s\n' 'if [ -x /usr/bin/deepcool-linux-port ]; then' '  exec /usr/bin/deepcool-linux-port "$@"' 'fi'
  printf 'exec %q "$@"\n' "$ROOT/scripts/run.sh"
} > "$BIN_SCRIPT"
chmod +x "$BIN_SCRIPT"

desktop_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}
EXEC_BIN="$(desktop_escape "$BIN_SCRIPT")"

ICON_SOURCE="$ROOT/work/windows-app/resources/app.asar.extracted/resources/icon.png"
if [ -f "$ICON_SOURCE" ]; then cp "$ICON_SOURCE" "$ICON_DIR/deepcool-official-linux.png"; fi
cat > "$APP_DIR/deepcool-official-linux.desktop" <<EOF2
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port)
Name[zh_CN]=DeepCool（Linux 移植版）
Comment=DeepCool 1.2.12 official UI with Arch Linux sensor and LM-Series bridge
Exec=$EXEC_BIN
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
