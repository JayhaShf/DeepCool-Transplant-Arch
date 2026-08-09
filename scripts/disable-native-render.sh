#!/usr/bin/env bash
# 关闭 daemon 原生渲染（Slint/Rust 监控画面），让 LCD 只显示当前项目
# （官方 DeepCool UI 移植层）推送的内容。
#
# 原理：通过 deepcool-lm-web 的 /api/config 写入 /etc/deepcool-lm/lcd.json
#   - renderer: "rust"（不再加载 Slint 渲染器）
#   - pages: [空页] + background: [0,0,0]（monitor 模式渲染纯黑，不显示任何内容）
# 并热加载 daemon。官方预设/推送激活时 daemon 进入 static，显示推送帧。
set -euo pipefail

API="http://127.0.0.1:8642/api/config"

config="$(curl -fsS --max-time 5 "$API")"
echo "$config" | python -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null || {
  echo "无法读取当前配置（deepcool-lm-web 未运行？）" >&2; exit 1
}

python - "$config" <<'PY' > /tmp/deepcool-only-official-render.json
import json, sys
cfg = json.loads(sys.argv[1])
cfg["renderer"] = "rust"
cfg["background"] = [0, 0, 0]
cfg["pages"] = [{"name": "blank", "widgets": []}]
cfg["carousel"] = {"enabled": False, "interval_secs": 15}
print(json.dumps(cfg, ensure_ascii=False, indent=2))
PY

printf '%s\n' '写入并热加载配置：'
curl -fsS --max-time 8 -X POST -H 'Content-Type: application/json' \
  --data-binary @/tmp/deepcool-only-official-render.json "$API" | python -m json.tool

sleep 1
printf '%s\n' '--- 校验 ---'
curl -fsS --max-time 5 "$API" | python -c 'import json,sys; c=json.load(sys.stdin)["config"]; print("renderer:",c["renderer"]); print("pages:",c["pages"]); print("background:",c["background"])'
curl -fsS --max-time 5 http://127.0.0.1:8642/api/status | python -c 'import json,sys; d=json.load(sys.stdin); print("daemon mode:",d.get("mode"),"error:",d.get("error"))'
echo
echo "完成：LCD 不再显示 daemon 原生 Slint/Rust 监控画面。"
echo "官方 UI 保存预设/推送预览时，LCD 只显示当前项目推送的内容。"
