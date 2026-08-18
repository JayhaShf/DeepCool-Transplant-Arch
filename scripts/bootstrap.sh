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
    VERSION="$(node -p 'require("./node_modules/electron/package.json").version')"
    PLATFORM="$(node -p 'process.platform')"
    ARCH="$(node -p 'process.arch')"
    EXPECTED_ZIP="electron-v${VERSION}-${PLATFORM}-${ARCH}.zip"
    EXPECTED_SHA256=""
    case "$EXPECTED_ZIP" in
      electron-v23.3.13-linux-x64.zip)
        EXPECTED_SHA256=2f9ab1c3bbacaa74b64f4f6ad92423302cc6b69a135ff1438a84233611e2f440
        ;;
    esac
    if [ -z "$EXPECTED_SHA256" ]; then
      echo "没有 $EXPECTED_ZIP 的固定 SHA-256，拒绝手工解压未认证缓存。" >&2
      echo "请修复网络后重新运行 node node_modules/electron/install.js。" >&2
      exit 1
    fi
    ZIP=""
    while IFS= read -r -d '' candidate; do
      actual="$(sha256sum -- "$candidate" | awk '{print $1}')"
      if [ "$actual" = "$EXPECTED_SHA256" ] && 7z t "$candidate" >/dev/null; then
        ZIP="$candidate"
        break
      fi
      echo "忽略校验失败的 Electron 缓存: $candidate" >&2
    done < <(find "$HOME/.cache/electron" -type f -name "$EXPECTED_ZIP" -print0 2>/dev/null)
    [ -n "$ZIP" ] || { echo "未找到通过 SHA-256 校验的 $EXPECTED_ZIP" >&2; exit 1; }

    TMP_DIST="$(mktemp -d "$ROOT/node_modules/electron/.dist.XXXXXX")"
    OLD_DIST="$ROOT/node_modules/electron/.dist-old.$$"
    cleanup_dist() {
      rm -rf -- "${TMP_DIST:-}" "${OLD_DIST:-}"
    }
    trap cleanup_dist EXIT
    7z x -y -o"$TMP_DIST" "$ZIP" >/dev/null
    [ -x "$TMP_DIST/electron" ] || { echo "Electron 缓存缺少可执行文件" >&2; exit 1; }
    ACTUAL_VERSION="$("$TMP_DIST/electron" --version 2>/dev/null | tail -n1)"
    [ "$ACTUAL_VERSION" = "v$VERSION" ] || {
      echo "Electron 缓存版本不符: 期望 v$VERSION，得到 $ACTUAL_VERSION" >&2
      exit 1
    }
    if [ -e node_modules/electron/dist ]; then
      mv -- node_modules/electron/dist "$OLD_DIST"
    fi
    mv -- "$TMP_DIST" node_modules/electron/dist
    TMP_DIST=""
    printf 'electron' > node_modules/electron/path.txt
    rm -rf -- "$OLD_DIST"
    OLD_DIST=""
    trap - EXIT
  fi
fi
[ -x node_modules/electron/dist/electron ] || {
  echo "Electron 二进制下载失败：$ROOT/node_modules/electron/dist/electron" >&2
  echo "可尝试 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 后重跑" >&2
  exit 1
}
EXPECTED_VERSION="$(node -p 'require("./node_modules/electron/package.json").version')"
ACTUAL_VERSION="$(node_modules/electron/dist/electron --version 2>/dev/null | tail -n1)"
[ "$ACTUAL_VERSION" = "v$EXPECTED_VERSION" ] || {
  echo "Electron 二进制版本不匹配：期望 v$EXPECTED_VERSION，得到 $ACTUAL_VERSION" >&2
  exit 1
}
"$ROOT/scripts/extract.sh" "$ROOT/DeepCool-1.2.12-setup.exe"
"$ROOT/scripts/prepare.sh" "$ROOT/work/windows-app"
