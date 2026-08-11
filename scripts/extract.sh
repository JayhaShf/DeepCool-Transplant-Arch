#!/usr/bin/env bash
# DeepCool 1.2.12: NSIS -> Electron payload -> app.asar.extracted
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP="${1:-$ROOT/DeepCool-1.2.12-setup.exe}"
NSIS_DIR="${NSIS_DIR:-$ROOT/work/nsis}"
APP_DIR="${APP_DIR:-$ROOT/work/windows-app}"
ASAR_BIN="$ROOT/node_modules/.bin/asar"

[ -f "$SETUP" ] || { echo "找不到安装包: $SETUP" >&2; exit 1; }
command -v 7z >/dev/null || { echo "缺少 7z（Arch: sudo pacman -S 7zip）" >&2; exit 1; }

if [ -f "$APP_DIR/resources/app.asar" ] && [ -d "$APP_DIR/resources/app.asar.extracted" ] && [ "${FORCE_EXTRACT:-0}" != 1 ]; then
  echo "已存在解包结果: $APP_DIR"
  echo "如需重解，执行 FORCE_EXTRACT=1 npm run extract"
  exit 0
fi

if [ "${FORCE_EXTRACT:-0}" = 1 ]; then
  # 路径安全：仅允许删除仓库 work/ 下的解包目录（NSIS_DIR/APP_DIR 可被环境变量覆盖，
  # 防止误设成 $HOME 等目录时 FORCE_EXTRACT 递归删除）
  case "$NSIS_DIR:$APP_DIR" in
    "$ROOT/work/"*:"$ROOT/work/"*) ;;
    *)
      echo "FORCE_EXTRACT 拒绝：NSIS_DIR/APP_DIR 必须在 \$ROOT/work 下（当前 $NSIS_DIR / $APP_DIR）" >&2
      exit 1
      ;;
  esac
  rm -rf "$NSIS_DIR" "$APP_DIR"
fi
mkdir -p "$NSIS_DIR" "$APP_DIR"

echo "[1/4] 解 NSIS 外壳"
7z x -y -o"$NSIS_DIR" "$SETUP" >/dev/null
PAYLOAD="$(find "$NSIS_DIR" -type f -name 'app-64.7z' -print -quit)"
[ -n "$PAYLOAD" ] || { echo "安装包中未找到 app-64.7z" >&2; exit 1; }

echo "[2/4] 解 Electron Windows payload"
7z x -y -o"$APP_DIR" "$PAYLOAD" >/dev/null
if [ -d "$APP_DIR/app" ] && [ ! -f "$APP_DIR/DeepCool.exe" ]; then
  shopt -s dotglob nullglob
  mv "$APP_DIR/app"/* "$APP_DIR/"
  rmdir "$APP_DIR/app"
fi

# NSIS 中有一部分新视频资源不在 app-64.7z，合并进 payload。
if [ -d "$NSIS_DIR/resources" ]; then
  mkdir -p "$APP_DIR/resources"
  cp -a -n "$NSIS_DIR/resources/." "$APP_DIR/resources/"
fi

ASAR="$APP_DIR/resources/app.asar"
[ -f "$ASAR" ] || { echo "找不到 $ASAR" >&2; exit 1; }

echo "[3/4] 解 app.asar"
rm -rf "$APP_DIR/resources/app.asar.extracted"
if [ -x "$ASAR_BIN" ]; then
  "$ASAR_BIN" extract "$ASAR" "$APP_DIR/resources/app.asar.extracted"
else
  npx --yes @electron/asar@3.2.17 extract "$ASAR" "$APP_DIR/resources/app.asar.extracted"
fi

echo "[4/4] 校验"
test -f "$APP_DIR/resources/app.asar.extracted/out/main/index.jsc"
test -f "$APP_DIR/resources/app.asar.extracted/out/renderer/index.html"
test -f "$APP_DIR/resources/app.asar.extracted/package.json"
file "$APP_DIR/resources/app.asar.extracted/out/main/index.jsc"
echo "完成: $APP_DIR"
