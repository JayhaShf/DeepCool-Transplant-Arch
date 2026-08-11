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
# 启动 + CDP 就绪轮询 + 失败自动重试。
# 背景：pkill 后立即重启时旧 Chromium 进程还在退出中，单实例锁未释放，
# 新进程会立刻 quit（requestSingleInstanceLock 失败），导致"点了没反应"。
# 这里后台启动 → 轮询 CDP/进程状态 → 未就绪且进程已退出则等旧实例死透后重试。
# 重复启动（app 已在跑）场景：新进程秒退，但 CDP 已就绪（旧实例）→ 直接成功。
launch_app() {
  env "${ENV_ARGS[@]}" "$ELECTRON" "${ARGS[@]}" >>"$LOG_FILE" 2>&1 &
  APP_PID=$!
}

# CDP 就绪检测：校验目标身份（页面 URL 含 app.asar.extracted），
# 防止 9333 被其他 Electron 实例占用时误判"启动成功"。
cdp_ready() {
  curl -fsS "http://127.0.0.1:$PORT/json" 2>/dev/null | grep -q "app.asar.extracted"
}

READY=0
for attempt in 1 2 3; do
  launch_app
  for _ in $(seq 1 20); do
    if cdp_ready; then
      READY=1
      break
    fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      break  # 进程已退出且 CDP 未就绪 → 本次启动失败
    fi
    sleep 1
  done
  if [ "$READY" = 1 ]; then
    break
  fi
  # 进程可能仍在运行但 CDP 未就绪（慢启动）：最多再等 15 秒
  for _ in $(seq 1 15); do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      break
    fi
    if cdp_ready; then
      READY=1
      break
    fi
    sleep 1
  done
  if [ "$READY" = 1 ]; then
    break
  fi
  wait "$APP_PID" 2>/dev/null || true
  if [ "$attempt" -lt 3 ]; then
    echo "启动未就绪（第 $attempt 次），等待旧实例退出后重试…"
    sleep 4
  fi
done

if [ "$READY" != 1 ]; then
  if kill -0 "$APP_PID" 2>/dev/null; then
    echo "警告：CDP 未就绪但进程仍在运行（PID $APP_PID，日志 $LOG_FILE）"
    echo "提示：可能是 9333 端口被占用或启动缓慢；进程保持运行，Ctrl+C 可终止。"
  else
    echo "错误：启动失败（3 次尝试后 CDP 无响应，日志 $LOG_FILE）" >&2
    exit 1
  fi
fi

# 保持前台等待（与原 exec 语义一致：终端 Ctrl+C 可终止 app）
wait "$APP_PID" || true
