#!/usr/bin/env bash
# 运行原生 Linux Electron 23 + DeepCool 1.2.12 官方 renderer/JSC。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${DEEPCOOL_APP_DIR:-$ROOT/work/windows-app}"
ELECTRON="${DEEPCOOL_ELECTRON:-$ROOT/node_modules/electron/dist/electron}"
PORT="${REMOTE_DEBUG_PORT:-9333}"
USER_DATA_DIR="${DEEPCOOL_USER_DATA_DIR:-$HOME/.config/DeepCool-Linux-Port}"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/deepcool-official-linux"
LOG_FILE="$LOG_DIR/app.log"

# 后台模式：--hidden / --background / DEEPCOOL_BACKGROUND=1
if [ "${DEEPCOOL_BACKGROUND:-0}" != "1" ]; then
  for arg in "$@"; do
    case "$arg" in
      --hidden|--background) DEEPCOOL_BACKGROUND=1 ;;
    esac
  done
fi
export DEEPCOOL_BACKGROUND

if [ ! -x "$ELECTRON" ] || [ ! -d "$APP/resources/app.asar.extracted" ]; then
  "$ROOT/scripts/bootstrap.sh"
fi
# 已打过补丁时跳过 prepare（桌面启动的耗时瓶颈之一）。
if [ ! -f "$APP/resources/app.asar.extracted/out/main/linux-compat.js" ] ||
   ! grep -q 'linux-compat.js' "$APP/resources/app.asar.extracted/out/main/bytecode-loader.js" ||
   ! grep -q 'linux-overlay.js' "$APP/resources/app.asar.extracted/out/renderer/index.html" ||
   [ "${DEEPCOOL_REPREPARE:-0}" = 1 ]; then
  "$ROOT/scripts/prepare.sh" "$APP" >/dev/null
fi
mkdir -p "$USER_DATA_DIR" "$LOG_DIR"

ARGS=(
  --no-sandbox
  --disable-gpu
  --no-first-run
  --disable-background-networking
  --disable-component-update
  --remote-debugging-port="$PORT"
  --user-data-dir="$USER_DATA_DIR"
  "$APP/resources/app.asar.extracted"
)

echo "DeepCool Linux Port"
echo "  Electron: $ELECTRON"
echo "  App:      $APP"
echo "  Data:     $USER_DATA_DIR"
echo "  CDP:      http://127.0.0.1:$PORT/json"
echo "  Log:      $LOG_FILE"

# Codex Desktop 自身会导出 ELECTRON_RENDERER_URL；若不清理，DeepCool 会误载
# Codex 的 5175 页面，而不是自己的 file:// renderer。
ENV_ARGS=(
  -u ELECTRON_RENDERER_URL
  -u VITE_DEV_SERVER_URL
  -u MAIN_VITE_DEV_SERVER_URL
  -u MAIN_VITE_NAME
  -u RENDERER_VITE_NAME
)
if [ -t 1 ]; then
  exec env "${ENV_ARGS[@]}" "$ELECTRON" "${ARGS[@]}" > >(tee -a "$LOG_FILE") 2>&1
else
  exec env "${ENV_ARGS[@]}" "$ELECTRON" "${ARGS[@]}" >>"$LOG_FILE" 2>&1
fi
