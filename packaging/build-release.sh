#!/usr/bin/env bash
# Build deterministic binary/source release archives and their verification metadata.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAME="deepcool-linux-port"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
VER="${1:-$PACKAGE_VERSION}"
PKGBUILD_VERSION="$(sed -n 's/^pkgver=//p' packaging/PKGBUILD)"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME-$VER"
SOURCE_STAGE="$DIST/source"
APP_SRC="$ROOT/work/windows-app"
EXTRACTED="$APP_SRC/resources/app.asar.extracted"
ELECTRON_SRC="$ROOT/node_modules/electron/dist"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct HEAD)}"

[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "版本必须是严格的 x.y.z: $VER" >&2
  exit 1
}
[ "$VER" = "$PACKAGE_VERSION" ] || {
  echo "发布版本 $VER 与 package.json $PACKAGE_VERSION 不一致" >&2
  exit 1
}
[ "$VER" = "$PKGBUILD_VERSION" ] || {
  echo "package.json $VER 与 PKGBUILD $PKGBUILD_VERSION 不一致" >&2
  exit 1
}
[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || {
  echo "SOURCE_DATE_EPOCH 必须是 Unix 时间戳" >&2
  exit 1
}

DIRTY=0
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  DIRTY=1
fi
if [ "$DIRTY" = 1 ] && [ "${ALLOW_DIRTY:-0}" != 1 ]; then
  echo "拒绝从 dirty worktree 构建发布；先提交变更，或仅在本地 smoke 时设置 ALLOW_DIRTY=1" >&2
  exit 1
fi

echo "== 前置校验 =="
[ -d "$EXTRACTED" ] || { echo "缺少 $EXTRACTED；先运行 npm run bootstrap" >&2; exit 1; }
[ -x "$ELECTRON_SRC/electron" ] || { echo "缺少 $ELECTRON_SRC/electron" >&2; exit 1; }
test -f "$EXTRACTED/out/main/index.jsc"
test -f "$EXTRACTED/out/main/linux-compat.js"
test -f "$EXTRACTED/out/preload/index.js"
test -f "$EXTRACTED/out/preload/ipc-policy.js"
test -f "$EXTRACTED/out/renderer/linux-overlay.js"
node --check patches/linux-compat.js
node --check patches/linux-overlay.js
node --check patches/bytecode-loader.js
node --check patches/preload-bridge.js
node --check patches/ipc-policy.js
npm run security:check
grep -q 'linux-compat.js' "$EXTRACTED/out/main/bytecode-loader.js"
grep -q 'ipc-policy.js' "$EXTRACTED/out/preload/index.js"
grep -q 'linux-overlay.js' "$EXTRACTED/out/renderer/index.html"
grep -Fq "object-src 'none'" "$EXTRACTED/out/renderer/index.html"
grep -Fq "object-src 'none'" "$EXTRACTED/out/renderer/launch.html"
grep -q '__SOURCE_TAR_SHA256__' packaging/PKGBUILD

echo "== 准备 staging =="
rm -rf "$DIST"
mkdir -p "$STAGE"/{app/resources,electron,bin,scripts,packaging}

echo "== 拷贝已打补丁应用与 Electron =="
cp -a "$EXTRACTED" "$STAGE/app/resources/app.asar.extracted"
find "$STAGE/app/resources/app.asar.extracted" -name '*.orig' -delete
rm -f "$STAGE/app/resources/app.asar.extracted/index.html" \
      "$STAGE/app/resources/app.asar.extracted/webpack.idea.js" \
      "$STAGE/app/resources/app.asar.extracted/commitlint.config.js" \
      "$STAGE/app/resources/app.asar.extracted/commitlint.config.cjs" \
      "$STAGE/app/resources/app.asar.extracted/.cz-config.js" \
      "$STAGE/app/resources/app.asar.extracted/.nvmrc" 2>/dev/null || true
cp -a "$ELECTRON_SRC/." "$STAGE/electron/"

echo "== 拷贝运行代码与安装器 =="
cp scripts/run.sh scripts/prepare.sh scripts/verify.sh scripts/install-user.sh \
   scripts/install-autostart.sh scripts/uninstall-user.sh scripts/uninstall-autostart.sh \
   scripts/reinstall-daemon.sh scripts/disable-native-render.sh scripts/security-check.sh "$STAGE/scripts/"
cp -a patches "$STAGE/patches"
cp -a daemon "$STAGE/daemon"
cp -a tools "$STAGE/tools"
cp package.json package-lock.json README.md SECURITY.md "$STAGE/"
install -m0755 packaging/install-tarball.sh "$STAGE/packaging/install-tarball.sh"
install -m0644 packaging/LICENSE "$STAGE/packaging/LICENSE"
install -m0644 packaging/README.md "$STAGE/packaging/README.md"

cat > "$STAGE/bin/deepcool-linux-port" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PREFIX="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
export DEEPCOOL_APP_DIR="$PREFIX/app"
export DEEPCOOL_ELECTRON="$PREFIX/electron/electron"
exec "$PREFIX/scripts/run.sh" "$@"
EOF
chmod +x "$STAGE/bin/deepcool-linux-port"

ICON_SRC="$STAGE/app/resources/app.asar.extracted/resources/icon.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$STAGE/bin/icon.png"
fi
cat > "$STAGE/deepcool-linux-port.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port)
Name[zh_CN]=DeepCool（Linux 移植版）
Comment=DeepCool 1.2.12 UI compatibility port for Arch Linux
Exec=/usr/bin/deepcool-linux-port
Icon=deepcool-linux-port
Terminal=false
StartupNotify=true
Categories=Settings;HardwareSettings;
StartupWMClass=DeepCool
EOF

cat > "$STAGE/INSTALL.txt" <<'EOF'
DeepCool Linux Port (Arch Linux x86_64)

Direct run:
  bin/deepcool-linux-port

System install, including daemon and desktop entry:
  sudo bash packaging/install-tarball.sh "$(pwd)"

For desktop autostart, invoke the installer through sudo from the target desktop
user and append --autostart. The archive bundles Electron but still needs the
Arch shared-library and Python dependencies documented in packaging/README.md.

This archive contains extracted DeepCool assets. Redistribution requires
separate authorization from the relevant copyright holders.
EOF

create_tar() {
  local output="$1"
  local directory="$2"
  local member="$3"
  TZ=UTC LC_ALL=C ZSTD_CLEVEL=19 tar \
    --sort=name \
    --mtime="@$SOURCE_DATE_EPOCH" \
    --owner=0 --group=0 --numeric-owner \
    --pax-option=delete=atime,delete=ctime \
    --zstd -cf "$output" -C "$directory" "$member"
}

echo "== 生成二进制 tar =="
BIN_TAR="$DIST/$NAME-$VER.tar.zst"
create_tar "$BIN_TAR" "$DIST" "$NAME-$VER"

echo "== 生成源码 tar =="
mkdir -p "$SOURCE_STAGE"
if [ "$DIRTY" = 1 ]; then
  echo "警告：ALLOW_DIRTY=1，仅用于本地 smoke；源码包取当前工作树" >&2
  git ls-files --cached --others --exclude-standard -z |
    tar --null -T - -cf - |
    tar -xf - -C "$SOURCE_STAGE"
else
  git archive --format=tar HEAD | tar -xf - -C "$SOURCE_STAGE"
fi
cat > "$SOURCE_STAGE/BUILDING.md" <<'EOF'
Build inputs:
  - this source archive
  - DeepCool-1.2.12-setup.exe with the SHA-256 recorded in dist/PKGBUILD

Use the separately published PKGBUILD and deepcool-linux-port.install files.
Put both beside this archive and the setup exe, then run makepkg -si.
EOF
SRC_TAR="$DIST/$NAME-$VER-source.tar.zst"
create_tar "$SRC_TAR" "$SOURCE_STAGE" .

echo "== 生成带固定 source hash 的 PKGBUILD =="
SOURCE_SHA256="$(sha256sum "$SRC_TAR" | awk '{print $1}')"
sed "s/__SOURCE_TAR_SHA256__/$SOURCE_SHA256/" packaging/PKGBUILD > "$DIST/PKGBUILD"
if grep -q '__SOURCE_TAR_SHA256__' "$DIST/PKGBUILD"; then
  echo "PKGBUILD source hash 替换失败" >&2
  exit 1
fi
install -m0644 packaging/deepcool-linux-port.install "$DIST/deepcool-linux-port.install"

echo "== 生成 CycloneDX SBOM =="
SBOM="$DIST/$NAME-$VER-sbom.cdx.json"
GIT_COMMIT="${GITHUB_SHA:-$(git rev-parse HEAD)}"
node - "$EXTRACTED" "$VER" "$SBOM" "$GIT_COMMIT" <<'NODE'
const fs = require('fs');
const path = require('path');

const appRoot = process.argv[2];
const releaseVersion = process.argv[3];
const output = process.argv[4];
const gitCommit = process.argv[5];
const components = new Map();

function add(name, version, type = 'library') {
  if (!name || !version) return;
  const key = `${name}@${version}`;
  if (components.has(key)) return;
  const purlName = name.split('/').map(encodeURIComponent).join('/');
  components.set(key, {
    type,
    name,
    version,
    'bom-ref': `pkg:npm/${purlName}@${encodeURIComponent(version)}`,
    purl: `pkg:npm/${purlName}@${encodeURIComponent(version)}`,
  });
}

function walk(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    const manifest = path.join(full, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        add(pkg.name, pkg.version);
      } catch {}
    }
    walk(full);
  }
}

const app = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
add(app.name, app.version, 'application');
add('electron', require('./node_modules/electron/package.json').version, 'framework');
walk(path.join(appRoot, 'node_modules'));

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'deepcool-linux-port',
      version: releaseVersion,
    },
    properties: [
      { name: 'deepcool:source-version', value: app.version },
      { name: 'deepcool:git-commit', value: gitCommit },
    ],
  },
  components: [...components.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
};
fs.writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`);
NODE

rm -rf "$STAGE" "$SOURCE_STAGE"

echo "== 生成发布校验和 =="
(
  cd "$DIST"
  sha256sum \
    "$NAME-$VER.tar.zst" \
    "$NAME-$VER-source.tar.zst" \
    "$NAME-$VER-sbom.cdx.json" \
    PKGBUILD \
    deepcool-linux-port.install > SHA256SUMS
  sha256sum -c SHA256SUMS
)

echo "== 完成 =="
ls -lh "$DIST"
