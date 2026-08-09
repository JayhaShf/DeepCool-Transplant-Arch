#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -d node_modules/electron ] || npm install --no-audit --no-fund
"$ROOT/scripts/extract.sh" "$ROOT/DeepCool-1.2.12-setup.exe"
"$ROOT/scripts/prepare.sh" "$ROOT/work/windows-app"
