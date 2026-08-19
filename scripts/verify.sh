#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${DEEPCOOL_APP_DIR:-}" ]; then
  APP="$DEEPCOOL_APP_DIR"
elif [ -d "$ROOT/app/resources/app.asar.extracted" ]; then
  APP="$ROOT/app"
else
  APP="$ROOT/work/windows-app"
fi
if [ -n "${DEEPCOOL_ELECTRON:-}" ]; then
  ELECTRON_BIN="$DEEPCOOL_ELECTRON"
elif [ -x "$ROOT/electron/electron" ]; then
  ELECTRON_BIN="$ROOT/electron/electron"
else
  ELECTRON_BIN="$ROOT/node_modules/.bin/electron"
fi
PORT="${REMOTE_DEBUG_PORT:-9333}"
VERIFY_JSON="$(mktemp "${TMPDIR:-/tmp}/deepcool-port-verify.XXXXXX.json")"
trap 'rm -f -- "$VERIFY_JSON"' EXIT

echo '--- 静态校验 ---'
test -f "$APP/resources/app.asar.extracted/out/main/index.jsc"
test -f "$APP/resources/app.asar.extracted/out/main/linux-compat.js"
test -f "$APP/resources/app.asar.extracted/out/preload/ipc-policy.js"
test -f "$APP/resources/app.asar.extracted/out/renderer/linux-overlay.js"
grep -q 'linux-compat.js' "$APP/resources/app.asar.extracted/out/main/bytecode-loader.js"
grep -q 'ipc-policy.js' "$APP/resources/app.asar.extracted/out/preload/index.js"
grep -q 'linux-overlay.js' "$APP/resources/app.asar.extracted/out/renderer/index.html"
grep -Fq "object-src 'none'" "$APP/resources/app.asar.extracted/out/renderer/index.html"
# 补丁源文件语法（work/ 内可能仍是旧副本，以 patches/ 为准）
node --check "$ROOT/patches/linux-compat.js"
node --check "$ROOT/patches/linux-overlay.js"
printf 'Electron: '; "$ELECTRON_BIN" --version 2>/dev/null | tail -n1
printf 'USB:      '; lsusb -d 3633:0026 | head -n1
printf 'Daemon:   '; systemctl is-active deepcool-lm-daemon.service 2>/dev/null || true
printf 'Socket:   '; ls -l /run/deepcool-lm/deepcool-lm.sock 2>/dev/null || echo '(missing)'

if curl -fsS "http://127.0.0.1:$PORT/json" >/dev/null 2>&1; then
  echo '--- 运行时校验 ---'
  python "$ROOT/tools/cdp_eval.py" "$PORT" index.html \
    '(async()=>{const status=await ipcRenderer.invoke("linux/status");const sensors=await ipcRenderer.invoke("app/get-sensors-data");const devices=await ipcRenderer.invoke("app/get-device-list");return {title:document.title,route:location.hash,overlay:!!document.querySelector("#dc-linux-bridge"),bridge:{hasObserver:typeof ipcRenderer.observeInvocations==="function"},daemon:{ok:status.ok,daemonOnline:status.daemon_online,healthy:status.healthy,deviceConnected:status.device_connected,workersOk:status.workers_ok,lastWriteOk:status.last_write_ok,lastWriteAt:status.last_write_at,mode:status.mode,socket:status.socket,error:status.error},cpu:sensors.data.cpu,gpu:sensors.data.gpu,memory:sensors.data.memory,devices:(devices.data||[]).map(d=>({productName:d.productName,productId:d.productId,vendorId:d.vendorId,serialNumber:d.serialNumber,subheadingName:d.subheadingName}))}})()' | tee "$VERIFY_JSON"
  grep -q '"title": "DeepCool"' "$VERIFY_JSON"
  grep -q '"overlay": true' "$VERIFY_JSON"
  grep -q '"hasObserver": true' "$VERIFY_JSON"
  grep -q '"ok": true' "$VERIFY_JSON"
  grep -q '"productName": "LM-Series"' "$VERIFY_JSON"
  if [ "${DEEPCOOL_REQUIRE_DEVICE:-0}" = 1 ]; then
    grep -q '"deviceConnected": true' "$VERIFY_JSON"
    grep -q '"workersOk": true' "$VERIFY_JSON"
  fi
  echo '运行时断言通过。'
else
  echo "运行时未启动或未开 CDP（端口 $PORT 无响应）。"
  echo "日常启动默认关闭 CDP；运行时校验请："
  echo "  npm run start:debug"
  echo "  # 另一终端："
  echo "  npm run verify"
fi
