#!/usr/bin/env bash
# Install a release tarball under /opt and register its daemon/desktop entry.
set -euo pipefail

usage() {
  echo "用法: install-tarball.sh <解压目录> [--autostart] [--user <桌面用户名>]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
SRC="$1"
shift
AUTOSTART=0
DESKTOP_USER="${SUDO_USER:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --autostart)
      AUTOSTART=1
      shift
      ;;
    --user)
      [ "$#" -ge 2 ] || usage
      DESKTOP_USER="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行" >&2; exit 1; }
SRC="$(cd "$SRC" && pwd -P)"
PREFIX="/opt/deepcool-linux-port"
[ ! -L "$PREFIX" ] || { echo "拒绝覆盖符号链接安装目录: $PREFIX" >&2; exit 1; }
case "$SRC/" in
  "$PREFIX/"*)
    echo "解压目录不能位于 $PREFIX 内；请从其他目录运行安装器" >&2
    exit 1
    ;;
esac
[ -d "$SRC/app/resources/app.asar.extracted" ] || { echo "不是有效解压目录: $SRC" >&2; exit 1; }
[ -x "$SRC/electron/electron" ] || { echo "缺少 $SRC/electron/electron" >&2; exit 1; }
[ -x "$SRC/bin/deepcool-linux-port" ] || { echo "缺少发布包启动器" >&2; exit 1; }
[ -x "$SRC/daemon/install-daemon.sh" ] || { echo "缺少 daemon 安装器" >&2; exit 1; }

DESKTOP_HOME=""
DESKTOP_GROUP=""
if [ -n "$DESKTOP_USER" ] && [ "$DESKTOP_USER" != root ]; then
  id "$DESKTOP_USER" >/dev/null 2>&1 || {
    echo "桌面用户不存在: $DESKTOP_USER" >&2
    exit 1
  }
fi
if [ "$AUTOSTART" = 1 ]; then
  [ -n "$DESKTOP_USER" ] && [ "$DESKTOP_USER" != root ] || {
    echo "--autostart 需要真实桌面用户；请通过 sudo 调用或附加 --user <用户名>" >&2
    exit 1
  }
  DESKTOP_HOME="$(getent passwd "$DESKTOP_USER" | cut -d: -f6)"
  [ -n "$DESKTOP_HOME" ] && [ -d "$DESKTOP_HOME" ] || {
    echo "无法确定用户 $DESKTOP_USER 的主目录" >&2
    exit 1
  }
  DESKTOP_GROUP="$(id -gn "$DESKTOP_USER")"
fi

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
cp -a "$SRC/packaging" "$PREFIX/packaging"
cp "$SRC"/{package.json,package-lock.json,README.md,SECURITY.md} "$PREFIX/" 2>/dev/null || true
chmod +x "$PREFIX/bin/deepcool-linux-port"

echo "== [2/5] 安装 daemon（pyusb/psutil/pillow + deepcool 组 + systemd + ACL）=="
if [ -n "$DESKTOP_USER" ] && [ "$DESKTOP_USER" != root ]; then
  SUDO_USER="$DESKTOP_USER" bash "$PREFIX/daemon/install-daemon.sh"
else
  bash "$PREFIX/daemon/install-daemon.sh"
fi

echo "== [3/5] 系统命令与桌面入口 =="
install -d /usr/bin /usr/share/applications /usr/share/icons/hicolor/256x256/apps
[ ! -e /usr/bin/deepcool-linux-port ] || [ -L /usr/bin/deepcool-linux-port ] || {
  echo "拒绝覆盖非符号链接启动器: /usr/bin/deepcool-linux-port" >&2
  exit 1
}
ln -sfn "$PREFIX/bin/deepcool-linux-port" /usr/bin/deepcool-linux-port
if [ -f "$PREFIX/app/resources/app.asar.extracted/resources/icon.png" ]; then
  install -m0644 "$PREFIX/app/resources/app.asar.extracted/resources/icon.png" \
    /usr/share/icons/hicolor/256x256/apps/deepcool-linux-port.png
fi
install -m0644 "$SRC/deepcool-linux-port.desktop" \
  /usr/share/applications/deepcool-linux-port.desktop
command -v update-desktop-database >/dev/null && update-desktop-database /usr/share/applications || true

echo "== [4/5] 自启（可选）=="
if [ "$AUTOSTART" = 1 ]; then
  AUTOSTART_DIR="$DESKTOP_HOME/.config/autostart"
  AUTOSTART_FILE="$AUTOSTART_DIR/deepcool-official-linux.desktop"
  install -d -m0755 -o "$DESKTOP_USER" -g "$DESKTOP_GROUP" "$AUTOSTART_DIR"
  TMP_DESKTOP="$(mktemp)"
  trap 'rm -f "$TMP_DESKTOP"' EXIT
  cat > "$TMP_DESKTOP" <<'EOF'
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port) Autostart
Name[zh_CN]=DeepCool（Linux 移植版）开机自启
Comment=Start DeepCool in background at login
Exec=/usr/bin/deepcool-linux-port --hidden
Icon=deepcool-linux-port
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
StartupNotify=false
EOF
  install -T --remove-destination -m0644 -o "$DESKTOP_USER" -g "$DESKTOP_GROUP" \
    "$TMP_DESKTOP" "$AUTOSTART_FILE"
  rm -f "$TMP_DESKTOP"
  trap - EXIT
  echo "已为 $DESKTOP_USER 启用开机自启: $AUTOSTART_FILE"
else
  echo "跳过自启（加 --autostart 启用）"
fi

echo "== [5/5] 校验 =="
[ "$(readlink -f /usr/bin/deepcool-linux-port)" = "$PREFIX/bin/deepcool-linux-port" ]
systemctl is-active deepcool-lm-daemon.service
ls -l /run/deepcool-lm/deepcool-lm.sock
getent group deepcool
echo
echo "完成。启动：deepcool-linux-port"
echo "若 LCD 无画面：sudo systemctl restart deepcool-lm-daemon"
echo "组权限提示：重新登录后桌面用户的 groups 应包含 deepcool。"
