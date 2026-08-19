#!/usr/bin/env bash
# 为 Linux 运行打补丁：Windows .node 桩 + IPC/传感器/LCD daemon 桥。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/work/windows-app}"
PATCHES="$ROOT/patches"
STUBS="$PATCHES/stubs"
EXTRACTED="$APP/resources/app.asar.extracted"
UNPACKED="$APP/resources/app.asar.unpacked"

[ -d "$EXTRACTED" ] || { echo "缺少 $EXTRACTED；先执行 npm run extract" >&2; exit 1; }

echo "[1/9] 安装 V8 字节码加载器与 .node shim"
MAIN="$EXTRACTED/out/main/bytecode-loader.js"
if [ -f "$MAIN" ] && [ ! -f "$MAIN.orig" ]; then cp "$MAIN" "$MAIN.orig"; fi
cp "$PATCHES/bytecode-loader.js" "$MAIN"

echo "[2/9] 为 Windows 专用控制器生成 JavaScript 桩"
for base in "$EXTRACTED/resources" "$UNPACKED/resources"; do
  [ -d "$base" ] || continue
  while IFS= read -r -d '' node; do
    stub="${node%.node}.stub.js"
    case "$node" in
      *system/system_info_x64.node|*system/system_info_x86.node) cp "$STUBS/system_info_stub.js" "$stub" ;;
      *) cp "$STUBS/controller_stub.js" "$stub" ;;
    esac
  done < <(find "$base" -name '*.node' -print0)
done

echo "[3/9] 替换 Windows Skia binding"
BINDING="$EXTRACTED/node_modules/node-canvas-skia/dist/binding.js"
if [ -f "$BINDING" ]; then
  [ -f "$BINDING.orig" ] || cp "$BINDING" "$BINDING.orig"
  cp "$STUBS/node-canvas-skia-binding.js" "$BINDING"
fi

echo "[4/9] 替换 Windows .NET/HWiNFO bridge"
EDGE="$EXTRACTED/node_modules/electron-edge-js/lib/edge.js"
if [ -f "$EDGE" ]; then
  [ -f "$EDGE.orig" ] || cp "$EDGE" "$EDGE.orig"
  cp "$STUBS/electron-edge-js-edge.js" "$EDGE"
fi

echo "[5/9] 安装 Linux IPC/传感器/LCD daemon 桥"
cp "$PATCHES/linux-compat.js" "$EXTRACTED/out/main/linux-compat.js"

echo "[6/9] 安装受限 preload IPC 桥"
PRELOAD_DIR="$EXTRACTED/out/preload"
PRELOAD="$PRELOAD_DIR/index.js"
if [ -f "$PRELOAD" ] && [ ! -f "$PRELOAD.orig" ]; then cp "$PRELOAD" "$PRELOAD.orig"; fi
cp "$PATCHES/preload-bridge.js" "$PRELOAD"
cp "$PATCHES/ipc-policy.js" "$PRELOAD_DIR/ipc-policy.js"

echo "[7/9] 安装 Linux 控制浮层"
cp "$PATCHES/linux-overlay.js" "$EXTRACTED/out/renderer/linux-overlay.js"
INDEX_HTML="$EXTRACTED/out/renderer/index.html"
if ! grep -q 'linux-overlay.js' "$INDEX_HTML"; then
  sed -i 's#</body>#  <script src="./linux-overlay.js"></script>\n</body>#' "$INDEX_HTML"
fi

echo "[8/9] 为本地 renderer 安装内容安全策略"
CSP="        <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self' data: blob: file:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: file:; font-src 'self' data: file:; media-src 'self' data: blob: file:; connect-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-src 'none'\">"
for html in "$INDEX_HTML" "$EXTRACTED/out/renderer/launch.html"; do
  [ -f "$html" ] || continue
  if ! grep -q "object-src 'none'" "$html"; then
    sed -i "/<meta charset=\"UTF-8\" \/>/a\\$CSP" "$html"
  fi
done

echo "[9/9] 语法与关键文件校验"
node --check "$PATCHES/linux-compat.js"
node --check "$PATCHES/linux-overlay.js"
node --check "$PATCHES/preload-bridge.js"
node --check "$PATCHES/ipc-policy.js"
node --check "$MAIN"
grep -q 'throw error' "$MAIN"
test -f "$EXTRACTED/out/main/index.jsc"
echo "准备完成: $APP"
