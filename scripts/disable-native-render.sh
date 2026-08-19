#!/usr/bin/env bash
# 关闭 daemon 原生渲染（Slint/Rust 监控画面），让 LCD 只显示当前项目
# （官方 DeepCool UI 移植层）推送的内容。
#
# 新版 Python daemon（daemon/deepcool-lm-daemon.py）本身无原生渲染：
# monitor 模式渲染纯黑，LCD 内容完全由移植层推帧。本脚本不再依赖
# 8642 web API（已移除），直接写入 /etc/deepcool-lm/lcd.json 作为
# 兼容占位（若未来换回 Rust daemon，该配置仍然生效）。
set -euo pipefail

CONFIG_DIR=/etc/deepcool-lm
CONFIG_FILE="$CONFIG_DIR/lcd.json"
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行: sudo $0" >&2; exit 1; }
[ ! -L "$CONFIG_DIR" ] || { echo "拒绝使用符号链接配置目录: $CONFIG_DIR" >&2; exit 1; }
if [ -e "$CONFIG_DIR" ] && [ ! -d "$CONFIG_DIR" ]; then
  echo "配置路径不是目录: $CONFIG_DIR" >&2
  exit 1
fi
mkdir -p -- "$CONFIG_DIR"
[ ! -L "$CONFIG_FILE" ] || { echo "拒绝覆盖符号链接配置文件: $CONFIG_FILE" >&2; exit 1; }
TEMP_FILE="$(mktemp "$CONFIG_DIR/.lcd.json.XXXXXX")"
trap 'rm -f -- "$TEMP_FILE"' EXIT
chmod 0644 "$TEMP_FILE"
cat > "$TEMP_FILE" <<'JSON'
{
  "renderer": "rust",
  "background": [0, 0, 0],
  "pages": [{ "name": "blank", "widgets": [] }]
}
JSON
mv -f -- "$TEMP_FILE" "$CONFIG_FILE"
trap - EXIT

echo "已写入 $CONFIG_FILE："
cat "$CONFIG_FILE"
echo
echo "完成：LCD 不再显示 daemon 原生 Slint/Rust 监控画面。"
echo "官方 UI 保存预设/推送预览时，LCD 只显示当前项目推送的内容。"
