#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${DEEPCOOL_APP_DIR:-$ROOT/work/windows-app}"
PORT="${REMOTE_DEBUG_PORT:-9333}"

echo '--- 静态校验 ---'
test -f "$APP/resources/app.asar.extracted/out/main/index.jsc"
test -f "$APP/resources/app.asar.extracted/out/main/linux-compat.js"
test -f "$APP/resources/app.asar.extracted/out/renderer/linux-overlay.js"
grep -q 'linux-compat.js' "$APP/resources/app.asar.extracted/out/main/bytecode-loader.js"
grep -q 'linux-overlay.js' "$APP/resources/app.asar.extracted/out/renderer/index.html"
# 补丁源文件语法（work/ 内可能仍是旧副本，以 patches/ 为准）
node --check "$ROOT/patches/linux-compat.js"
node --check "$ROOT/patches/linux-overlay.js"
printf 'Electron: '; "$ROOT/node_modules/.bin/electron" --version 2>/dev/null | tail -n1
printf 'USB:      '; lsusb -d 3633:0026 | head -n1
printf 'Daemon:   '; systemctl is-active deepcool-lm-daemon.service 2>/dev/null || true
printf 'Socket:   '; ls -l /run/deepcool-lm/deepcool-lm.sock 2>/dev/null || echo '(missing)'

if curl -fsS "http://127.0.0.1:$PORT/json" >/dev/null 2>&1; then
  echo '--- 运行时校验 ---'
  python "$ROOT/tools/cdp_eval.py" "$PORT" index.html \
    '(async()=>{const status=await ipcRenderer.invoke("linux/status");const sensors=await ipcRenderer.invoke("app/get-sensors-data");const devices=await ipcRenderer.invoke("app/get-device-list");return {title:document.title,route:location.hash,overlay:!!document.querySelector("#dc-linux-bridge"),daemon:{ok:status.ok,mode:status.mode,socket:status.socket,error:status.error},cpu:sensors.data.cpu,gpu:sensors.data.gpu,memory:sensors.data.memory,devices:(devices.data||[]).map(d=>({productName:d.productName,productId:d.productId,vendorId:d.vendorId,serialNumber:d.serialNumber,subheadingName:d.subheadingName}))}})()' | tee /tmp/deepcool-port-verify.json
  grep -q '"title": "DeepCool"' /tmp/deepcool-port-verify.json
  grep -q '"overlay": true' /tmp/deepcool-port-verify.json
  grep -q '"ok": true' /tmp/deepcool-port-verify.json
  grep -q '"productName": "LM-Series"' /tmp/deepcool-port-verify.json
  echo '运行时断言通过。'
else
  echo "运行时未启动或未开 CDP（端口 $PORT 无响应）。"
  echo "日常启动默认关闭 CDP；运行时校验请："
  echo "  npm run start:debug"
  echo "  # 另一终端："
  echo "  npm run verify"
fi
