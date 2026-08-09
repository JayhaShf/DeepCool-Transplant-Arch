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

echo "[1/7] 安装 V8 字节码加载器与 .node shim"
MAIN="$EXTRACTED/out/main/bytecode-loader.js"
if [ -f "$MAIN" ] && [ ! -f "$MAIN.orig" ]; then cp "$MAIN" "$MAIN.orig"; fi
cp "$PATCHES/bytecode-loader.js" "$MAIN"

echo "[2/7] 为 Windows 专用控制器生成 JavaScript 桩"
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

echo "[3/7] 替换 Windows Skia binding"
BINDING="$EXTRACTED/node_modules/node-canvas-skia/dist/binding.js"
if [ -f "$BINDING" ]; then
  [ -f "$BINDING.orig" ] || cp "$BINDING" "$BINDING.orig"
  cp "$STUBS/node-canvas-skia-binding.js" "$BINDING"
fi

echo "[4/7] 替换 Windows .NET/HWiNFO bridge"
EDGE="$EXTRACTED/node_modules/electron-edge-js/lib/edge.js"
if [ -f "$EDGE" ]; then
  [ -f "$EDGE.orig" ] || cp "$EDGE" "$EDGE.orig"
  cp "$STUBS/electron-edge-js-edge.js" "$EDGE"
fi

echo "[5/7] 安装 Linux IPC/传感器/LCD daemon 桥"
cp "$PATCHES/linux-compat.js" "$EXTRACTED/out/main/linux-compat.js"

echo "[6/7] 安装 Linux 控制浮层"
cp "$PATCHES/linux-overlay.js" "$EXTRACTED/out/renderer/linux-overlay.js"
INDEX_HTML="$EXTRACTED/out/renderer/index.html"
if ! grep -q 'linux-overlay.js' "$INDEX_HTML"; then
  sed -i 's#</body>#  <script src="./linux-overlay.js"></script>\n</body>#' "$INDEX_HTML"
fi

echo "[7/7] 语法与关键文件校验"
node --check "$PATCHES/linux-compat.js"
node --check "$PATCHES/linux-overlay.js"
node --check "$MAIN"
test -f "$EXTRACTED/out/main/index.jsc"
echo "准备完成: $APP"
