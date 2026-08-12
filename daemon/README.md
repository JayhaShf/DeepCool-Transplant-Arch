# deepcool-lm daemon（Python 重写版）

> 原 Rust daemon（deepcool-lm-rust）源码已丢失：从未推送到 GitHub，且随重装系统
> 从本地消失。本目录按移植层（`patches/linux-compat.js` / `linux-overlay.js`）
> 锁定的协议规格重写，功能等价、协议兼容，源码随本仓库备份（不再丢失）。

## 文件

| 文件 | 说明 |
|---|---|
| `deepcool-lm-daemon.py` | 单文件 daemon（socket 服务 + 传感器采样 + USB 推帧） |
| `deepcool-lm-daemon.service` | systemd unit（root 运行，自动重启） |
| `install-daemon.sh` | 一键安装：依赖 + deepcool 组 + unit + 启动 + 自检 |

## 安装

```bash
sudo bash daemon/install-daemon.sh
# 组权限需重新登录或: newgrp deepcool
groups | grep deepcool
```

依赖（Arch）：`python-pyusb`、`python-psutil`、`python-pillow`（脚本自动装）。

访问控制：socket **0660 root:deepcool**（仅 root 与 `deepcool` 组成员可连接）。
`install-daemon.sh` 会 `groupadd -f deepcool` 并把 `SUDO_USER` 加入该组。

## 协议（与移植层锁定一致）

Unix socket `/run/deepcool-lm/deepcool-lm.sock`（0660 root:deepcool），JSON 请求，
一次连接一个请求（发送后 shutdown 写端，服务端读到 EOF 后响应并关闭）。

| 动作 | 参数 | 响应 |
|---|---|---|
| `status` | — | `{ok, mode, snapshot}` |
| `monitor` | — | 监控模式（LCD 黑屏 + 持续采样） |
| `zen` | — | 待机（黑帧待机：LCD 显示纯黑，恢复推帧即点亮；不使用硬件 zen toggle 命令，见下） |
| `image` | `data`: PNG base64 | 解码 320×240 → RGB565 → USB 推帧，持续重发 |
| `brightness` | `direction`: `up`/`down` | 硬件亮度步进 |

`snapshot` 字段与 `linux-compat.js` 的 `fallbackStatus()` 完全一致：
`cpu_temp/cpu_usage/cpu_power/cpu_freq(GHz)/gpu_temp/gpu_usage/gpu_power/gpu_freq/
gpu_mem_used/gpu_mem_total/mem_used/mem_total/mem_percent/disks[]/nets[]/fans[]/local_time`。

传感器来源：hwmon coretemp/k10temp（CPU 温度）、RAPL powercap（CPU 功耗）、
psutil（使用率/频率/内存/磁盘网络速率差分）、nvidia-smi（GPU 全套）、
`/sys/class/hwmon` 风扇。**始终采样**（任何模式下快照都实时）。

## USB 细节

- 设备：`3633:0026`（DeepCool LM-Series），Bulk OUT `0x01`
- 帧：13 字节帧头 `aa 08 00 00 01 00 58 02 00 2c 01 bc 11` + 153600 字节 RGB565 小端
- 命令：brightness_up `aa 04 00 06 03 61 00 d2 46`、brightness_down `aa 04 00 06 03 1d 00 e6 0b`、
  init `aa 01 00 09 29 91`
- 待机不使用硬件 zen 命令（`aa 04 00 03 00 00 00 dc 9b`）：toggle 是"切换"语义，
  关屏后恢复推帧不保证重新开屏（LCD 保持黑屏）；黑帧待机恢复推帧时自然点亮。
- 以上命令来自 [daedlock/deepcool-lm](https://github.com/daedlock/deepcool-lm)
  （LM360 实测）；设备型号不同时帧头/命令可能需要调整

## 手动测试

```bash
# 状态
python3 -c "import socket,json;s=socket.socket(socket.AF_UNIX);s.connect('/run/deepcool-lm/deepcool-lm.sock');s.sendall(b'{\"action\":\"status\"}');s.shutdown(1);print(s.recv(65536).decode())"
# 推一张图（任意 PNG → base64）
python3 -c "
import socket,json,base64
png=base64.b64encode(open('/path/img.png','rb').read()).decode()
s=socket.socket(socket.AF_UNIX);s.connect('/run/deepcool-lm/deepcool-lm.sock')
s.sendall(json.dumps({'action':'image','data':png}).encode());s.shutdown(1)
print(s.recv(65536).decode())"
# 待机 / 亮度
echo '{"action":"zen"}' | socat - UNIX-CONNECT:/run/deepcool-lm/deepcool-lm.sock
echo '{"action":"brightness","direction":"up"}' | socat - UNIX-CONNECT:/run/deepcool-lm/deepcool-lm.sock
```

## 与移植层集成

- `linux-compat.js` 自动探测 `SOCKET_CANDIDATES`（`/run/deepcool-lm/deepcool-lm.sock` 优先），
  无需改动
- `scripts/verify.sh` 运行时断言 `linux/status → ok:true`
- 本 daemon 无原生渲染（无 Slint）：monitor 模式 LCD 纯黑，
  LCD 内容完全由移植层 overlay 推帧（预设/图片/预览），符合"只保留当前项目渲染"架构
