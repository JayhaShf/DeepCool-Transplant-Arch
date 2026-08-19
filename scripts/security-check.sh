#!/usr/bin/env bash
# Validate the supported Electron 23 security posture without pretending that
# the vendor V8 bytecode can be rebuilt on a newer Electron.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXPECTED_ELECTRON="23.3.13"
if [ -n "${DEEPCOOL_ELECTRON:-}" ]; then
  ELECTRON_BIN="$DEEPCOOL_ELECTRON"
elif [ -x "$ROOT/node_modules/electron/dist/electron" ]; then
  ELECTRON_BIN="$ROOT/node_modules/electron/dist/electron"
else
  ELECTRON_BIN="$ROOT/electron/electron"
fi
if [ -n "${DEEPCOOL_APP_DIR:-}" ]; then
APP="$DEEPCOOL_APP_DIR"
elif [ -d "$ROOT/work/windows-app" ]; then
  APP="$ROOT/work/windows-app"
else
  APP="$ROOT/app"
fi
SOURCE_ONLY="${DEEPCOOL_SECURITY_SOURCE_ONLY:-0}"

[ -x "$ELECTRON_BIN" ] || { echo "缺少 Electron: $ELECTRON_BIN" >&2; exit 1; }
[ -f "$ROOT/package-lock.json" ] || { echo "缺少 package-lock.json，无法执行依赖审计" >&2; exit 1; }
actual_version="$("$ELECTRON_BIN" --version 2>/dev/null | tail -n1)"
[ "$actual_version" = "v$EXPECTED_ELECTRON" ] || {
  echo "Electron 版本不匹配：期望 v$EXPECTED_ELECTRON，得到 $actual_version" >&2
  exit 1
}

if [ "$SOURCE_ONLY" = 1 ]; then
  echo 'source-only security check: extracted vendor payload checks skipped'
else
  EXTRACTED="$APP/resources/app.asar.extracted"
  [ -f "$EXTRACTED/out/main/linux-compat.js" ]
  [ -f "$EXTRACTED/out/main/bytecode-loader.js" ]
  [ -f "$EXTRACTED/out/preload/index.js" ]
  [ -f "$EXTRACTED/out/preload/ipc-policy.js" ]
  [ -f "$EXTRACTED/out/renderer/linux-overlay.js" ]
  grep -q 'linux-compat.js' "$EXTRACTED/out/main/bytecode-loader.js"
  grep -q 'ipc-policy.js' "$EXTRACTED/out/preload/index.js"
  grep -q 'linux-overlay.js' "$EXTRACTED/out/renderer/index.html"
  grep -Fq "script-src 'self' 'unsafe-eval'" "$EXTRACTED/out/renderer/index.html"
  grep -Fq "script-src 'self' 'unsafe-eval'" "$EXTRACTED/out/renderer/launch.html"
  grep -Fq "object-src 'none'" "$EXTRACTED/out/renderer/index.html"
  grep -Fq "object-src 'none'" "$EXTRACTED/out/renderer/launch.html"
fi
grep -q 'setWindowOpenHandler' patches/linux-compat.js
grep -q 'assertTrustedIpcSender' patches/linux-compat.js
grep -q 'observeInvocations' patches/preload-bridge.js

# The launcher's effective ARGS block must never grow a no-sandbox escape hatch.
if sed -n '/^ARGS=(/,/^)/p' scripts/run.sh | grep -q -- '--no-sandbox'; then
  echo 'scripts/run.sh 含有 --no-sandbox，拒绝通过安全检查' >&2
  exit 1
fi
grep -q 'SANDBOX_READY=0' scripts/run.sh
grep -q 'remote-debugging-address=127.0.0.1' scripts/run.sh

audit_tmp="$(mktemp "${TMPDIR:-/tmp}/deepcool-audit.XXXXXX.json")"
runtime_tmp="$(mktemp "${TMPDIR:-/tmp}/deepcool-runtime-audit.XXXXXX.json")"
cleanup() { rm -f -- "$audit_tmp" "$runtime_tmp"; }
trap cleanup EXIT

runtime_rc=0
npm audit --omit=dev --json >"$runtime_tmp" 2>/dev/null || runtime_rc=$?
[ "$runtime_rc" = 0 ] || {
  echo '运行时 npm 依赖审计失败：存在未接受的漏洞或无法完成审计' >&2
  exit "$runtime_rc"
}
node - "$runtime_tmp" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const totals = report.metadata?.vulnerabilities || {};
if (Number(totals.total || 0) !== 0) {
  throw new Error(`runtime audit has vulnerabilities: ${JSON.stringify(totals)}`);
}
NODE

# Full audit is intentionally recorded as a risk-acceptance check. Electron
# 23's vendor bytecode constraint means these two advisories are expected; any
# additional package or severity change must fail the gate and be reviewed.
audit_rc=0
npm audit --json >"$audit_tmp" 2>/dev/null || audit_rc=$?
node - "$audit_tmp" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const names = Object.keys(report.vulnerabilities || {}).sort();
const expected = ['electron', 'extract-zip'];
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  throw new Error(`unexpected audit packages: ${names.join(', ')}`);
}
const totals = report.metadata?.vulnerabilities || {};
if (Number(totals.high || 0) !== 2 || Number(totals.total || 0) !== 2
  || Number(totals.critical || 0) !== 0) {
  throw new Error(`unexpected audit totals: ${JSON.stringify(totals)}`);
}
NODE
[ "$audit_rc" != 0 ] || echo '警告：完整 npm audit 返回 0，但预期残余风险仍应复核' >&2

echo "security check passed: Electron $EXPECTED_ELECTRON; runtime npm audit clean; accepted advisories: electron, extract-zip"
