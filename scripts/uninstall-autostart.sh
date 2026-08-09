#!/usr/bin/env bash
# 移除开机自启（不删除应用本身）
set -euo pipefail
rm -f "$HOME/.config/autostart/deepcool-official-linux.desktop"
echo "已移除开机自启。"
