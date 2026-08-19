#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo '--- Node unit tests ---'
node --test tests/*.test.js

echo '--- Python unit tests ---'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s daemon/tests -p 'test_*.py' -v

echo '--- Source syntax ---'
[ -x daemon/install-daemon.sh ] || {
  echo 'daemon/install-daemon.sh must be executable' >&2
  exit 1
}
mapfile -d '' -t shell_scripts < <(find scripts daemon packaging -type f -name '*.sh' -print0)
for script in "${shell_scripts[@]}"; do
  bash -n "$script"
done
node --check patches/linux-compat.js
node --check patches/linux-overlay.js
node --check patches/preload-bridge.js
node --check patches/ipc-policy.js
node --check patches/bytecode-loader.js
python3 -m py_compile daemon/deepcool-lm-daemon.py
bash -n scripts/security-check.sh
grep -Fq "script-src 'self' 'unsafe-eval'" scripts/prepare.sh

echo 'All deterministic tests passed.'
