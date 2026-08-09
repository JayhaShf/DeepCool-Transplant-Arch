#!/usr/bin/env bash
set -euo pipefail
rm -f "$HOME/.local/bin/deepcool-official-linux"
rm -f "$HOME/.local/share/applications/deepcool-official-linux.desktop"
rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/deepcool-official-linux.png"
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
echo '用户级启动器已删除；项目和解包文件未删除。'
