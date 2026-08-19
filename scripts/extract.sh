#!/usr/bin/env bash
# DeepCool 1.2.12: NSIS -> Electron payload -> app.asar.extracted
# 7-Zip 二进制可用 ZIP_BIN 环境变量覆盖（CI 上 Ubuntu p7zip 16.02 解 NSIS 会对部分
# mp4 报 Data Error，须用官方 7-Zip 7zz，例如：ZIP_BIN=/path/to/7zz bash scripts/extract.sh）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP="${1:-$ROOT/DeepCool-1.2.12-setup.exe}"
ASAR_BIN="$ROOT/node_modules/.bin/asar"
SEVENZIP="${ZIP_BIN:-7z}"
EXPECTED_SETUP_SHA256="4549885c716e951dde488e2117823478f7994c475e686331f93866582f6b116f"

# 解包会覆盖和递归删除输出目录，因此所有输出都必须在规范化后的 work/ 内。
mkdir -p -- "$ROOT/work"
[ ! -L "$ROOT/work" ] || { echo "拒绝使用符号链接 work 目录: $ROOT/work" >&2; exit 1; }
WORK_ROOT="$(realpath -e -- "$ROOT/work")"
safe_work_child() {
  local requested="$1" resolved
  resolved="$(realpath -m -- "$requested")"
  case "$resolved" in
    "$WORK_ROOT"/*) printf '%s\n' "$resolved" ;;
    *) echo "拒绝不安全的解包路径（必须是 $WORK_ROOT 的子目录）: $requested" >&2; return 1 ;;
  esac
}
NSIS_DIR="$(safe_work_child "${NSIS_DIR:-$ROOT/work/nsis}")"
APP_DIR="$(safe_work_child "${APP_DIR:-$ROOT/work/windows-app}")"
[ "$NSIS_DIR" != "$APP_DIR" ] || { echo "NSIS_DIR 与 APP_DIR 不能相同" >&2; exit 1; }

[ -f "$SETUP" ] || { echo "找不到安装包: $SETUP" >&2; exit 1; }
command -v "$SEVENZIP" >/dev/null || { echo "缺少 7z（Arch: sudo pacman -S 7zip；CI 用官方 7zz 并设 7Z 变量）" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "缺少 sha256sum" >&2; exit 1; }
ACTUAL_SETUP_SHA256="$(sha256sum -- "$SETUP" | awk '{print $1}')"
[ "$ACTUAL_SETUP_SHA256" = "$EXPECTED_SETUP_SHA256" ] || {
  echo "官方安装包 SHA-256 不匹配，拒绝解包" >&2
  echo "期望: $EXPECTED_SETUP_SHA256" >&2
  echo "实际: $ACTUAL_SETUP_SHA256" >&2
  exit 1
}

if [ -f "$APP_DIR/resources/app.asar" ] && [ -d "$APP_DIR/resources/app.asar.extracted" ] && [ "${FORCE_EXTRACT:-0}" != 1 ]; then
  echo "已存在解包结果: $APP_DIR"
  echo "如需重解，执行 FORCE_EXTRACT=1 npm run extract"
  exit 0
fi

if [ "${FORCE_EXTRACT:-0}" = 1 ]; then
  rm -rf -- "$NSIS_DIR" "$APP_DIR"
fi
mkdir -p -- "$NSIS_DIR" "$APP_DIR"

echo "[1/4] 解 NSIS 外壳（7z=$SEVENZIP）"
"$SEVENZIP" x -y -o"$NSIS_DIR" "$SETUP" >/dev/null
PAYLOAD="$(find "$NSIS_DIR" -type f -name 'app-64.7z' -print -quit)"
[ -n "$PAYLOAD" ] || { echo "安装包中未找到 app-64.7z" >&2; exit 1; }

echo "[2/4] 解 Electron Windows payload"
"$SEVENZIP" x -y -o"$APP_DIR" "$PAYLOAD" >/dev/null
if [ -d "$APP_DIR/app" ] && [ ! -f "$APP_DIR/DeepCool.exe" ]; then
  shopt -s dotglob nullglob
  mv -- "$APP_DIR/app"/* "$APP_DIR/"
  rmdir -- "$APP_DIR/app"
fi

# NSIS 中有一部分新视频资源不在 app-64.7z，合并进 payload。
if [ -d "$NSIS_DIR/resources" ]; then
  mkdir -p "$APP_DIR/resources"
  cp -a -n "$NSIS_DIR/resources/." "$APP_DIR/resources/"
fi

ASAR="$APP_DIR/resources/app.asar"
[ -f "$ASAR" ] || { echo "找不到 $ASAR" >&2; exit 1; }

echo "[3/4] 解 app.asar"
rm -rf -- "$APP_DIR/resources/app.asar.extracted"
if [ -x "$ASAR_BIN" ]; then
  "$ASAR_BIN" extract "$ASAR" "$APP_DIR/resources/app.asar.extracted"
else
  echo "缺少锁定的 asar 工具: $ASAR_BIN；请先运行 npm ci" >&2
  exit 1
fi

echo "[4/4] 校验"
test -f "$APP_DIR/resources/app.asar.extracted/out/main/index.jsc"
test -f "$APP_DIR/resources/app.asar.extracted/out/renderer/index.html"
test -f "$APP_DIR/resources/app.asar.extracted/package.json"
file "$APP_DIR/resources/app.asar.extracted/out/main/index.jsc"
echo "完成: $APP_DIR"
