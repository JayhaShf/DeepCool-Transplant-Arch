#!/usr/bin/env bash
# 关闭 daemon 原生渲染（Slint/Rust 监控画面），让 LCD 只显示当前项目
# （官方 DeepCool UI 移植层）推送的内容。
#
# 新版 Python daemon（daemon/deepcool-lm-daemon.py）本身无原生渲染：
# monitor 模式渲染纯黑，LCD 内容完全由移植层推帧。本脚本不再依赖
# 8642 web API（已移除），直接写入 /etc/deepcool-lm/lcd.json 作为
# 兼容占位（若未来换回 Rust daemon，该配置仍然生效）。
set -euo pipefail

mkdir -p /etc/deepcool-lm
cat > /etc/deepcool-lm/lcd.json <<'JSON'
{
  "renderer": "rust",
  "background": [0, 0, 0],
  "pages": [{ "name": "blank", "widgets": [] }]
}
JSON

echo "已写入 /etc/deepcool-lm/lcd.json："
cat /etc/deepcool-lm/lcd.json
echo
echo "完成：LCD 不再显示 daemon 原生 Slint/Rust 监控画面。"
echo "官方 UI 保存预设/推送预览时，LCD 只显示当前项目推送的内容。"
