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

# A source checkout may not contain Electron after the app has been installed
# from the binary archive. Reuse that validated runtime before attempting a
# network bootstrap, so stale user launchers cannot fail with an env/path error.
if [ -z "${DEEPCOOL_APP_DIR:-}" ] && [ -z "${DEEPCOOL_ELECTRON:-}" ] \
   && [ ! -x "$ELECTRON" ] \
   && [ -x /opt/deepcool-linux-port/electron/electron ] \
   && [ -d /opt/deepcool-linux-port/app/resources/app.asar.extracted ]; then
  APP="/opt/deepcool-linux-port/app"
  ELECTRON="/opt/deepcool-linux-port/electron/electron"
fi

# daemon socket 为 0660 root:deepcool。用户已在 deepcool 组但当前会话未加载
# （未重新登录）时 connect 会 EACCES，LCD 无画面。用 newgrp 重入补上有效组。
# DEEPCOOL_GROUP_ACTIVE=1 防止 newgrp 后无限重入。
if [ "${DEEPCOOL_GROUP_ACTIVE:-0}" != "1" ] && command -v newgrp >/dev/null 2>&1; then
  if getent group deepcool >/dev/null 2>&1; then
    _me="$(id -un 2>/dev/null || true)"
    _in_file=0
    if [ -n "$_me" ] && getent group deepcool | awk -F: -v u="$_me" '{print "," $4 ","}' | grep -q ",${_me},"; then
      _in_file=1
    fi
    _active=0
    if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx deepcool; then
      _active=1
    fi
    if [ "$_in_file" = 1 ] && [ "$_active" = 0 ]; then
      export DEEPCOOL_GROUP_ACTIVE=1
      # newgrp（非 login 模式）继承环境；恢复命令及参数全部 shell-escape。
      printf -v _resume_cmd 'cd %q && exec /usr/bin/bash %q' "$ROOT" "$ROOT/scripts/run.sh"
      for _resume_arg in "$@"; do
        printf -v _quoted_arg ' %q' "$_resume_arg"
        _resume_cmd+="$_quoted_arg"
      done
      exec newgrp deepcool <<EOF
$_resume_cmd
EOF
    fi
  fi
fi

# CDP：默认关闭（任意本地用户可对调试端口 Runtime.evaluate）。
# 调试/verify：DEEPCOOL_CDP=1 npm start  或  npm run start:debug
case "${DEEPCOOL_CDP:-0}" in
  1|true|TRUE|yes|YES|on|ON) ENABLE_CDP=1 ;;
  *) ENABLE_CDP=0 ;;
esac

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

# Electron 必须使用 Chromium sandbox。支持 setuid helper 或内核 user namespace；
# 两者都不可用时明确失败，不静默退回 --no-sandbox。
SANDBOX_READY=0
SANDBOX_HELPER="$(dirname "$ELECTRON")/chrome-sandbox"
if [ -e "$SANDBOX_HELPER" ]; then
  read -r HELPER_UID HELPER_GID HELPER_MODE < <(stat -c '%u %g %a' "$SANDBOX_HELPER")
  if [ ! -L "$SANDBOX_HELPER" ] && [ -f "$SANDBOX_HELPER" ] \
     && [ "$HELPER_UID" = 0 ] && [ "$HELPER_GID" = 0 ] && [ "$HELPER_MODE" = 4755 ]; then
    SANDBOX_READY=1
  fi
fi
if [ "$SANDBOX_READY" != 1 ] && command -v unshare >/dev/null 2>&1 && unshare -Ur true 2>/dev/null; then
  SANDBOX_READY=1
fi
if [ "$SANDBOX_READY" != 1 ]; then
  echo "错误：Chromium sandbox 不可用；拒绝使用 --no-sandbox 启动。" >&2
  echo "请启用非特权 user namespace，或将 $SANDBOX_HELPER 配置为 root:root 4755。" >&2
  exit 1
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
  --disable-gpu
  --no-first-run
  --disable-background-networking
  --disable-component-update
  --user-data-dir="$USER_DATA_DIR"
  "$APP/resources/app.asar.extracted"
)
if [ "$ENABLE_CDP" = 1 ]; then
  case "$PORT" in
    ''|*[!0-9]*) echo "REMOTE_DEBUG_PORT 必须是 1024..65535 的数字" >&2; exit 2 ;;
  esac
  if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
    echo "REMOTE_DEBUG_PORT 必须在 1024..65535" >&2
    exit 2
  fi
  ARGS=(--remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" "${ARGS[@]}")
fi

echo "DeepCool Linux Port"
echo "  Electron: $ELECTRON"
echo "  App:      $APP"
echo "  Data:     $USER_DATA_DIR"
if [ "$ENABLE_CDP" = 1 ]; then
  echo "  CDP:      http://127.0.0.1:$PORT/json"
else
  echo "  CDP:      未启用（DEEPCOOL_CDP=1 或 npm run start:debug）"
fi
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
# 启动 + 就绪轮询 + 失败自动重试。
# 背景：pkill 后立即重启时旧 Chromium 进程还在退出中，单实例锁未释放，
# 新进程会立刻 quit（requestSingleInstanceLock 失败），导致"点了没反应"。
# 这里后台启动 → 轮询就绪/进程状态 → 未就绪且进程已退出则等旧实例死透后重试。
# 重复启动（app 已在跑）场景：新进程秒退，但旧实例仍存活 → 直接成功。
launch_app() {
  env "${ENV_ARGS[@]}" "$ELECTRON" "${ARGS[@]}" >>"$LOG_FILE" 2>&1 &
  APP_PID=$!
}

# CDP 就绪：校验目标身份（页面 URL 含 app.asar.extracted），
# 防止端口被其他 Electron 实例占用时误判"启动成功"。
cdp_ready() {
  curl -fsS "http://127.0.0.1:$PORT/json" 2>/dev/null | grep -q "app.asar.extracted"
}

# 无 CDP 时：进程稳定存活即视为就绪（无法做页面身份校验）。
# 秒退（单实例锁失败）会在存活窗口内被发现并触发重试。
process_alive() {
  kill -0 "$APP_PID" 2>/dev/null
}

READY=0
for attempt in 1 2 3; do
  launch_app
  if [ "$ENABLE_CDP" = 1 ]; then
    for _ in $(seq 1 20); do
      if cdp_ready; then
        READY=1
        break
      fi
      if ! process_alive; then
        break  # 进程已退出且 CDP 未就绪 → 本次启动失败
      fi
      sleep 1
    done
    if [ "$READY" != 1 ]; then
      # 进程可能仍在运行但 CDP 未就绪（慢启动）：最多再等 15 秒
      for _ in $(seq 1 15); do
        if ! process_alive; then
          break
        fi
        if cdp_ready; then
          READY=1
          break
        fi
        sleep 1
      done
    fi
  else
    # 无 CDP：先等 4 秒观察是否秒退；仍存活则就绪
    STABLE=1
    for _ in $(seq 1 4); do
      if ! process_alive; then
        STABLE=0
        break
      fi
      sleep 1
    done
    if [ "$STABLE" = 1 ]; then
      READY=1
    fi
  fi
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
  if process_alive; then
    echo "警告：启动校验未通过但进程仍在运行（PID $APP_PID，日志 $LOG_FILE）"
    if [ "$ENABLE_CDP" = 1 ]; then
      echo "提示：可能是 $PORT 端口被占用或启动缓慢；进程保持运行，Ctrl+C 可终止。"
    else
      echo "提示：进程保持运行，Ctrl+C 可终止。调试可用 DEEPCOOL_CDP=1。"
    fi
  else
    if [ "$ENABLE_CDP" = 1 ]; then
      echo "错误：启动失败（3 次尝试后 CDP 无响应，日志 $LOG_FILE）" >&2
    else
      echo "错误：启动失败（3 次尝试后进程未稳定存活，日志 $LOG_FILE）" >&2
    fi
    exit 1
  fi
fi

# 保持前台等待（与原 exec 语义一致：终端 Ctrl+C 可终止 app）
wait "$APP_PID" || true
