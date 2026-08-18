# deepcool-lm daemon（Python 重写版）

> 本目录包含当前使用的 Python daemon。它按移植层（`patches/linux-compat.js` /
> `linux-overlay.js`）锁定的协议规格实现，兼容旧 Rust daemon 的 socket 字段；
> 当前 LCD 内容由 overlay Canvas 生成，daemon 只负责采样、USB 写帧和保活。

## 文件

| 文件 | 说明 |
|---|---|
| `deepcool-lm-daemon.py` | 单文件 daemon（socket 服务 + 传感器采样 + USB 推帧） |
| `deepcool-lm-daemon.service` | systemd unit（受限 root、资源上限、失败退避） |
| `install-daemon.sh` | 带预检、失败回滚和协议自检的安装器 |
| `../scripts/uninstall-daemon.sh` | 对称卸载；`--purge` 可清配置和组 |
| `tests/test_daemon.py` | 不接触真机的协议、输入边界和生命周期测试 |

## 安装

```bash
sudo bash daemon/install-daemon.sh
# 账号是否在组：groups jay | grep deepcool
# 当前会话 id 未必有 deepcool（登录早于加组时正常），不必强求
```

依赖（Arch）：`python-pyusb`、`python-psutil`、`python-pillow`（脚本自动安装）。

访问控制：socket **0660 root:deepcool**，不写会延迟撤销的 named-user ACL。
- `usermod -aG` 后若不注销，`id`/`id -nG` **不会**出现 deepcool（会话凭证固定）；
- 正常注销重登即可；`run.sh` 会为安装后尚未重登的当前会话安全执行 `newgrp`。

卸载：

```bash
sudo bash scripts/uninstall-daemon.sh          # 保留配置和 deepcool 组
sudo bash scripts/uninstall-daemon.sh --purge  # 同时删除兼容配置和专用组
```

## 协议（与移植层锁定一致）

Unix socket `/run/deepcool-lm/deepcool-lm.sock`（0660 root:deepcool），JSON 请求，
一次连接一个请求（发送后 shutdown 写端，服务端读到 EOF 后响应并关闭）。

| 动作 | 参数 | 响应 |
|---|---|---|
| `status` | — | 保留 `{ok, mode, snapshot}`，另含 device/worker/last-write/frame 健康字段 |
| `monitor` | — | 监控模式（LCD 黑屏 + 持续采样） |
| `zen` | — | 待机（黑帧待机：LCD 显示纯黑，恢复推帧即点亮；不使用硬件 zen toggle 命令，见下） |
| `image` | `data`; 可选 `confirm_timeout_ms`（0..2000） | `{ok, accepted, seq, delivered}`；接受后缓存并异步推帧 |
| `brightness` | `direction`: `up`/`down` | 硬件亮度步进 |

`snapshot` 字段与 `linux-compat.js` 的 `fallbackStatus()` 完全一致：
`cpu_temp/cpu_usage/cpu_power/cpu_freq(GHz)/gpu_temp/gpu_usage/gpu_power/gpu_freq/
gpu_mem_used/gpu_mem_total/mem_used/mem_total/mem_percent/disks[]/nets[]/fans[]/local_time`。

传感器来源：hwmon coretemp/k10temp（CPU 温度）、RAPL powercap（CPU 功耗）、
psutil（使用率/频率/内存/磁盘网络速率差分）、nvidia-smi（GPU 全套）、
`/sys/class/hwmon` 风扇。**始终采样**（任何模式下快照都实时）。

`status.ok` 只表示协议请求成功，保持旧移植层兼容。硬件与后台线程需分别检查
`device_connected`、`workers_ok`、`last_write_ok/at/kind/error`；完整细节位于
`device`、`workers` 和 `frame`。图片只接受严格 base64 PNG，压缩数据最多 2 MiB、
单边最多 4096 像素、总计最多 400 万像素；socket 最多并发处理 8 个请求。

## USB 细节

- 设备：`3633:0026`（DeepCool LM-Series），Bulk OUT `0x01`
- 帧：13 字节帧头 `aa 08 00 00 01 00 58 02 00 2c 01 bc 11` + 153600 字节 RGB565 小端
- 命令：brightness_up `aa 04 00 06 03 61 00 d2 46`、brightness_down `aa 04 00 06 03 1d 00 e6 0b`、
  init `aa 01 00 09 29 91`
- 待机不使用硬件 zen 命令（`aa 04 00 03 00 00 00 dc 9b`）：toggle 是"切换"语义，
  关屏后恢复推帧不保证重新开屏（LCD 保持黑屏）；黑帧待机恢复推帧时自然点亮。
- **链路策略（减少“只能断电才亮”）**：
  - **单写者**：`image` 请求只更新帧缓存；仅 `frame_loop` 写 USB
  - **512B 分包** bulk 负载；校验写入长度
  - **reset 节制**：启动先直接 claim；仅 claim/写入失败才 reset，冷却 90s、每小时最多 8 次
  - **跨重启预算**：成功 reset 时间写入 `/var/lib/deepcool-lm/reset-state.json`，崩溃重启不会清零限额
  - **应用降压**：overlay 数字布局 ~2s 一推；静态图只推一次，由 daemon 保活重发
- 若设备已进入“bulk 成功但不刷新”的固件死锁，软件 reset **不一定**够，仍可能需断电 POR。
- 以上命令来自 [daedlock/deepcool-lm](https://github.com/daedlock/deepcool-lm)
  （LM360 实测）；设备型号不同时帧头/命令可能需要调整

## 权限与隔离

当前 USB 节点为 `root:root 0664`，sysfs reauth 还需写 `authorized`，因此 unit 暂保留
`User=root`。它显式清空全部 capabilities，并启用只读系统/家目录、网络地址族限制、
namespace/SUID 限制及 `MemoryMax=256M`、`TasksMax=64`。若未来增加并实测专用 udev
规则与 NVIDIA 设备授权，可进一步切换到专用非 root 服务账号。

## 手动测试

```bash
# 状态
python3 -c "import socket,json;s=socket.socket(socket.AF_UNIX);s.connect('/run/deepcool-lm/deepcool-lm.sock');s.sendall(b'{\"action\":\"status\"}');s.shutdown(1);print(s.recv(65536).decode())"
# 推一张符合上述字节/像素上限的 PNG
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

纯模拟测试（不会打开 USB 或连接真实 daemon）：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s daemon/tests -p 'test_*.py' -v
```

## 与移植层集成

- `linux-compat.js` 自动探测 `SOCKET_CANDIDATES`（`/run/deepcool-lm/deepcool-lm.sock` 优先），
  无需改动
- `scripts/verify.sh` 运行时断言 `linux/status → ok:true`
- 本 daemon 无原生渲染（无 Slint）：monitor 模式 LCD 纯黑，
  LCD 内容完全由移植层 overlay 推帧（预设/图片/预览），符合"只保留当前项目渲染"架构
