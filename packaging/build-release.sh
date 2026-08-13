#!/usr/bin/env bash
# 构建 DeepCool Linux Port 二进制发布包（自包含 tar + 源码 tar + PKGBUILD 引用）。
#
# 产物（dist/，gitignore）：
#   deepcool-linux-port-<ver>.tar.zst          自包含：Electron + 预打补丁应用 + 代码，解压即用
#   deepcool-linux-port-<ver>-source.tar.zst   纯代码（patches/daemon/scripts/...），供 PKGBUILD 构建
#   PKGBUILD                                   引用 source tar + DeepCool-1.2.12-setup.exe
#
# 前置：本仓库已完成 bootstrap（node_modules/electron + work/windows-app 已解包打补丁）。
# 用法：bash packaging/build-release.sh [版本号]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="${1:-0.1.0}"
NAME="deepcool-linux-port"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME-$VER"
APP_SRC="$ROOT/work/windows-app"
EXTRACTED="$APP_SRC/resources/app.asar.extracted"
ELECTRON_SRC="$ROOT/node_modules/electron/dist"

echo "== 前置校验 =="
[ -d "$EXTRACTED" ] || { echo "缺少 $EXTRACTED；先运行 npm run bootstrap / npm run extract" >&2; exit 1; }
[ -d "$ELECTRON_SRC" ] || { echo "缺少 $ELECTRON_SRC；先运行 npm install（electron）" >&2; exit 1; }
[ -x "$ELECTRON_SRC/electron" ] || { echo "$ELECTRON_SRC/electron 不存在或不可执行" >&2; exit 1; }
test -f "$EXTRACTED/out/main/index.jsc"
test -f "$EXTRACTED/out/main/linux-compat.js"
test -f "$EXTRACTED/out/renderer/linux-overlay.js"
# 补丁语法（本机有 node；运行时不需要）
command -v node >/dev/null && {
  node --check patches/linux-compat.js
  node --check patches/linux-overlay.js
  node --check patches/bytecode-loader.js
}
# 校验补丁已注入（prepare.sh 的 markers）
grep -q 'linux-compat.js' "$EXTRACTED/out/main/bytecode-loader.js"
grep -q 'linux-overlay.js' "$EXTRACTED/out/renderer/index.html"
echo "前置 OK"

echo "== 清理与准备 $STAGE =="
rm -rf "$DIST"
mkdir -p "$STAGE"/{app,electron,bin,scripts}

echo "== 拷贝应用最小集（app.asar.extracted，剔除 .orig 与 Windows 残留）=="
mkdir -p "$STAGE/app/resources"
cp -a "$EXTRACTED" "$STAGE/app/resources/app.asar.extracted"
# 删除 prepare 备份与无关文件
find "$STAGE/app/resources/app.asar.extracted" -name '*.orig' -delete
rm -f "$STAGE/app/resources/app.asar.extracted/index.html" \
      "$STAGE/app/resources/app.asar.extracted/webpack.idea.js" \
      "$STAGE/app/resources/app.asar.extracted/commitlint.config.js" \
      "$STAGE/app/resources/app.asar.extracted/commitlint.config.cjs" \
      "$STAGE/app/resources/app.asar.extracted/.cz-config.js" \
      "$STAGE/app/resources/app.asar.extracted/.nvmrc" 2>/dev/null || true

echo "== 拷贝 Electron 运行时 =="
cp -a "$ELECTRON_SRC/." "$STAGE/electron/"

echo "== 拷贝代码（scripts/patches/daemon/tools）=="
cp scripts/run.sh scripts/prepare.sh scripts/verify.sh scripts/install-user.sh \
   scripts/install-autostart.sh scripts/uninstall-user.sh scripts/uninstall-autostart.sh \
   scripts/reinstall-daemon.sh scripts/disable-native-render.sh "$STAGE/scripts/"
cp -a patches "$STAGE/patches"
cp -a daemon "$STAGE/daemon"
cp -a tools "$STAGE/tools"
cp package.json README.md "$STAGE/"

echo "== 生成启动器 bin/deepcool-linux-port =="
cat > "$STAGE/bin/deepcool-linux-port" <<EOF
#!/usr/bin/env bash
# DeepCool Linux Port 启动器（自包含 tar 布局）
# 运行要求：bash/curl/getent/newgrp；daemon 由 packaging/install-tarball.sh 安装
set -euo pipefail
PREFIX="\$(cd "\$(dirname "\$(readlink -f "\$0")")/.." && pwd)"
export DEEPCOOL_APP_DIR="\$PREFIX/app"
export DEEPCOOL_ELECTRON="\$PREFIX/electron/electron"
exec "\$PREFIX/scripts/run.sh" "\$@"
EOF
chmod +x "$STAGE/bin/deepcool-linux-port"

echo "== 生成桌面入口 =="
ICON_SRC="$STAGE/app/resources/app.asar.extracted/resources/icon.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$STAGE/bin/icon.png"
  ICON_LINE="Icon=$(readlink -f "$STAGE/bin/icon.png")"
else
  ICON_LINE="Icon=applications-electron"
fi
cat > "$STAGE/deepcool-linux-port.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port)
Name[zh_CN]=DeepCool（Linux 移植版）
Comment=DeepCool 1.2.12 official UI with Arch Linux sensor and LM-Series bridge
Exec=$(readlink -f "$STAGE/bin/deepcool-linux-port")
${ICON_LINE}
Terminal=false
StartupNotify=true
Categories=Settings;HardwareSettings;
StartupWMClass=DeepCool
EOF

echo "== 写入打包版说明 =="
cat > "$STAGE/INSTALL.txt" <<'EOF'
DeepCool Linux Port（自包含 tar）

运行
  bin/deepcool-linux-port            # 前台
  bin/deepcool-linux-port --hidden   # 后台/托盘

前置（一次性，root）
  1) 安装 daemon（pyusb/psutil/pillow + deepcool 组 + systemd + socket ACL）：
       sudo bash daemon/install-daemon.sh
  2) 若系统无 ffmpeg：sudo pacman -S ffmpeg   （GIF/视频抽帧用）
  3) 确认当前会话含 deepcool 组：groups "$USER" | grep deepcool
     （加组后需重新登录；ACL 已按用户授权，多数场景无需重登）

环境变量（可选）
  DEEPCOOL_USER_DATA_DIR  用户数据目录（默认 ~/.config/DeepCool-Linux-Port）
  DEEPCOOL_CDP=1          开启调试端口（默认关）
  DEEPCOOL_APP_DIR / DEEPCOOL_ELECTRON  覆盖应用/Electron 路径

桌面/自启
  参考 packaging/install-tarball.sh（/opt 安装：/usr/bin 启动器 + 菜单 + daemon）

版权
  本包内含 DeepCool 官方解包素材（app/、部分 node_modules 二进制）与 Electron。
  官方素材版权属 DeepCool；请勿再分发官方 payload。分发前自行评估许可。
EOF

echo "== 打包 =="
# 1) 二进制自包含 tar
BIN_TAR="$DIST/$NAME-$VER.tar.zst"
tar --zstd -cf "$BIN_TAR" -C "$DIST" "$NAME-$VER"
echo "二进制包: $BIN_TAR"

# 2) 源码 tar（git 跟踪的代码 + 构建说明），供 PKGBUILD / 合规分发
SOURCE_STAGE="$DIST/source"
rm -rf "$SOURCE_STAGE"
mkdir -p "$SOURCE_STAGE"
git archive --format=tar HEAD | tar -x -C "$SOURCE_STAGE"
cat > "$SOURCE_STAGE/BUILDING.md" <<'EOF'
构建二进制：
  1) 将 DeepCool-1.2.12-setup.exe 放到仓库根目录
  2) npm install && npm run bootstrap   （需 node/npm/7z；下载 Electron）
  3) bash packaging/build-release.sh    （产出 dist/ 自包含 tar）
或使用仓库内 PKGBUILD（source 需同时提供本 tar 与 setup.exe）。
EOF
SRC_TAR="$DIST/$NAME-$VER-source.tar.zst"
tar --zstd -cf "$SRC_TAR" -C "$SOURCE_STAGE" .
echo "源码包:  $SRC_TAR"

echo "== 完成 =="
ls -lh "$DIST" | grep -E 'tar.zst|PKGBUILD' || ls -lh "$DIST"
