#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# 检测 Electron 二进制本体（npm 包目录存在 ≠ 二进制已下载）。
# npm 对已存在的包会跳过 postinstall，此时手动执行官方下载脚本补下。
if [ ! -x node_modules/electron/dist/electron ]; then
  npm install --no-audit --no-fund
  # install.js：下载 zip 到 ~/.cache/electron 并解压。注意本机环境里
  # extract-zip 曾出现只解出部分文件却静默成功的异常，因此若二进制仍缺失，
  # 直接用 7z 从缓存 zip 解压（7z 是本项目解包主力，已验证可用）。
  node node_modules/electron/install.js || true
  if [ ! -x node_modules/electron/dist/electron ]; then
    ZIP="$(find "$HOME/.cache/electron" -name 'electron-v*.zip' -print -quit 2>/dev/null || true)"
    if [ -n "$ZIP" ]; then
      rm -rf node_modules/electron/dist
      mkdir -p node_modules/electron/dist
      7z x -y -o"$ROOT/node_modules/electron/dist" "$ZIP" >/dev/null
      printf 'electron' > node_modules/electron/path.txt
    fi
  fi
fi
[ -x node_modules/electron/dist/electron ] || {
  echo "Electron 二进制下载失败：$ROOT/node_modules/electron/dist/electron" >&2
  echo "可尝试 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 后重跑" >&2
  exit 1
}
"$ROOT/scripts/extract.sh" "$ROOT/DeepCool-1.2.12-setup.exe"
"$ROOT/scripts/prepare.sh" "$ROOT/work/windows-app"
