#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deepcool-lm-daemon.py — DeepCool LM-Series LCD daemon（Linux / Python 重写）

原 Rust daemon（deepcool-lm-rust）源码已丢失（重装系统 + GitHub 无备份），
本文件按 DeepCool-Transplant-Arch 移植层锁定的协议规格重写，保证兼容：

  - Unix socket  `/run/deepcool-lm/deepcool-lm.sock`（0660 root:deepcool，root 运行）
    JSON 请求（一次连接一个请求，读到 EOF 结束），动作：
      {"action": "status"}                                  → {ok, mode, snapshot}
      {"action": "monitor"}                                 → 监控模式（纯黑帧，保持采样）
      {"action": "zen"}                                     → 待机（黑帧：LCD 纯黑，恢复推帧即点亮）
      {"action": "image", "data": "<png base64>"}           → 显示图片（320×240 RGB565 推帧）
      {"action": "brightness", "direction": "up"|"down"}    → 硬件亮度步进
    snapshot 字段与 linux-compat.js 的 fallbackStatus() 完全一致。

    - 传感器：psutil + hwmon coretemp/k10temp + RAPL + nvidia-smi，
      始终采样（static/zen 模式下也实时更新，对应原 21:27 版行为）。

    - USB：3633:0026，Bulk OUT 0x01；帧 = 13 字节帧头 + 153600 字节 RGB565 小端。
      USB 命令（帧头/亮度/init）来自 daedlock/deepcool-lm（LM360 实测）。
      zen 不使用硬件 toggle 命令：toggle 是"切换"语义，关屏后恢复推帧不保证
      重新开屏（LCD 保持黑屏）；黑帧待机恢复推帧时 LCD 自然点亮。
      链路策略（防固件卡死需断电）：
        * 仅 frame_loop 写帧（image 请求只更新缓存，不并发打 USB）
        * 帧负载按 512B 分包；写失败才 reset，且有冷却/次数上限
        * 启动只做一次温和 reset，避免 reset 风暴

  - 无内置 web API（8642 已按用户要求移除）；lcd.json 由 install 脚本直接写入。

用法（systemd 由 daemon/deepcool-lm-daemon.service 管理）：
    sudo python3 deepcool-lm-daemon.py [--socket /run/deepcool-lm/deepcool-lm.sock]
"""

import argparse
import base64
import grp
import io
import json
import os
import socket
import sys
import threading
import time

import psutil

from PIL import Image

VENDOR_ID = 0x3633
PRODUCT_ID = 0x0026
EP_OUT = 0x01
WIDTH = 320
HEIGHT = 240
FB_SIZE = WIDTH * HEIGHT * 2  # 153600
USB_CHUNK = 512               # 与端点 wMaxPacketSize 一致

# 帧头与命令（daedlock/deepcool-lm 在 LM360 上实测可用）
FRAME_HEADER = bytes([0xaa, 0x08, 0x00, 0x00, 0x01, 0x00, 0x58, 0x02, 0x00, 0x2c, 0x01, 0xbc, 0x11])
CMD_BRIGHTNESS_UP = bytes([0xaa, 0x04, 0x00, 0x06, 0x03, 0x61, 0x00, 0xd2, 0x46])
CMD_BRIGHTNESS_DOWN = bytes([0xaa, 0x04, 0x00, 0x06, 0x03, 0x1d, 0x00, 0xe6, 0x0b])
CMD_INIT_QUERY = bytes([0xaa, 0x01, 0x00, 0x09, 0x29, 0x91])

SAMPLE_INTERVAL = 2.0     # 传感器采样周期
FRAME_INTERVAL = 3.0      # 保活重发（略放慢，减轻 bulk 压力）
CONNECT_SETTLE = 1.0      # claim 后等待再写
RESET_COOLDOWN = 90.0     # 两次 USB reset 最小间隔（秒）
MAX_RESETS_PER_HOUR = 8   # 每小时 reset 上限，防止风暴把固件打挂
MAX_MSG = 20 * 1024 * 1024


def log(*args):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}]", *args, flush=True)


# ---------------------------------------------------------------------------
# USB
# ---------------------------------------------------------------------------

class LMDevice:
    """3633:0026 控制器：连接/重连、写命令与帧。

    设计要点（避免固件卡死只能断电）：
    - 帧只由 Daemon.frame_loop 经 send_frame 写出（单写者）
    - bulk 负载按 512B 分包
    - USB reset 有冷却与每小时上限；成功推帧后清除 pending reset
    """

    def __init__(self):
        self._dev = None
        self._lock = threading.Lock()
        self._connect_generation = 0
        self._pending_reset = True   # 进程启动后第一次连接做一次 reset（软重启恢复）
        self._last_reset_at = 0.0
        self._reset_times = []       # 时间戳列表，用于小时窗口限流

    @property
    def connected(self):
        return self._dev is not None

    def request_reset(self, reason=""):
        """标记下次 connect 需要 reset（写失败时调用）。"""
        self._pending_reset = True
        if reason:
            log("请求下次 USB reset:", reason)

    def _reset_allowed(self):
        now = time.time()
        self._reset_times = [t for t in self._reset_times if now - t < 3600]
        if len(self._reset_times) >= MAX_RESETS_PER_HOUR:
            log(f"USB reset 已达每小时上限 {MAX_RESETS_PER_HOUR}，跳过（需断电则只能断电）")
            return False
        if now - self._last_reset_at < RESET_COOLDOWN:
            log(f"USB reset 冷却中（{RESET_COOLDOWN:.0f}s），跳过")
            return False
        return True

    def connect(self):
        """打开设备。仅在 _pending_reset 且通过限流时总线复位。"""
        try:
            import usb.core
            import usb.util
        except ImportError:
            log("pyusb 未安装（sudo pacman -S python-pyusb）")
            return False
        self.disconnect()
        do_reset = self._pending_reset and self._reset_allowed()
        try:
            dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
            if dev is None:
                return False
            if do_reset:
                try:
                    dev.reset()
                    self._last_reset_at = time.time()
                    self._reset_times.append(self._last_reset_at)
                    self._pending_reset = False
                    log("USB reset 已发送，等待重枚举…")
                    time.sleep(1.5)
                except Exception as exc:
                    log("USB reset 失败，尝试 sysfs reauth:", exc)
                    self._sysfs_reauth()
                    self._last_reset_at = time.time()
                    self._reset_times.append(self._last_reset_at)
                    self._pending_reset = False
                    time.sleep(1.2)
                dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
                if dev is None:
                    log("USB reset/reauth 后设备未重现")
                    return False
            else:
                # 不 reset：清 pending 以免永远卡着（冷却中则下次再试）
                if self._pending_reset:
                    log("暂缓 USB reset，先尝试直接 claim")
            try:
                if dev.is_kernel_driver_active(0):
                    dev.detach_kernel_driver(0)
            except Exception:
                pass
            try:
                dev.set_configuration()
            except Exception as exc:
                log("set_configuration:", exc)
            try:
                usb.util.claim_interface(dev, 0)
            except Exception as exc:
                log("claim_interface 失败:", exc)
                # claim 失败时下次值得 reset
                self._pending_reset = True
                return False
            self._dev = dev
            self._connect_generation += 1
            log(f"USB 已连接 (gen={self._connect_generation}, reset={do_reset})")
            time.sleep(CONNECT_SETTLE)
            n = self._raw_write(CMD_INIT_QUERY)
            if n <= 0:
                log("INIT_QUERY 写入失败")
                self._pending_reset = True
                self.disconnect()
                return False
            time.sleep(0.15)
            return True
        except Exception as exc:
            self._dev = None
            log("USB 连接失败:", exc)
            return False

    @staticmethod
    def _sysfs_reauth():
        """通过 sysfs authorized 0→1 强制 USB 重枚举（reset 失败时）。"""
        try:
            base = "/sys/bus/usb/devices"
            for name in os.listdir(base):
                d = os.path.join(base, name)
                try:
                    with open(os.path.join(d, "idVendor")) as fh:
                        if fh.read().strip().lower() != f"{VENDOR_ID:04x}":
                            continue
                    with open(os.path.join(d, "idProduct")) as fh:
                        if fh.read().strip().lower() != f"{PRODUCT_ID:04x}":
                            continue
                except OSError:
                    continue
                auth = os.path.join(d, "authorized")
                if not os.path.exists(auth):
                    continue
                log("sysfs reauth:", d)
                with open(auth, "w") as fh:
                    fh.write("0\n")
                time.sleep(0.5)
                with open(auth, "w") as fh:
                    fh.write("1\n")
                return
        except Exception as exc:
            log("sysfs reauth 失败:", exc)

    def disconnect(self):
        dev, self._dev = self._dev, None
        if dev is None:
            return
        try:
            import usb.util
            usb.util.release_interface(dev, 0)
            usb.util.dispose_resources(dev)
        except Exception:
            pass

    def _raw_write(self, data):
        if self._dev is None:
            return 0
        try:
            return self._dev.write(EP_OUT, data, timeout=5000)
        except Exception as exc:
            log("USB 写入失败:", exc)
            self.disconnect()
            return 0

    def _raw_write_chunked(self, data):
        """按 USB_CHUNK 分包写满 data，返回总字节数；中途失败返回已写量并 disconnect。"""
        if self._dev is None:
            return 0
        total = 0
        try:
            for i in range(0, len(data), USB_CHUNK):
                chunk = data[i : i + USB_CHUNK]
                n = self._dev.write(EP_OUT, chunk, timeout=5000)
                if n != len(chunk):
                    log(f"分包写入不完整 offset={i} n={n}/{len(chunk)}")
                    self.disconnect()
                    return total + max(n, 0)
                total += n
            return total
        except Exception as exc:
            log("USB 分包写入失败:", exc)
            self.disconnect()
            return total

    def write(self, data):
        """带锁写小命令（亮度等）。"""
        with self._lock:
            return self._raw_write(data)

    def send_frame(self, framebuffer):
        """帧头 + 512B 分包负载，同一把锁内完成。失败返回 False。"""
        if framebuffer is None or len(framebuffer) != FB_SIZE:
            log(f"send_frame: 非法帧长度 {0 if framebuffer is None else len(framebuffer)}")
            return False
        with self._lock:
            n1 = self._raw_write(FRAME_HEADER)
            if n1 != len(FRAME_HEADER):
                log(f"send_frame: 帧头异常 n={n1}")
                self.request_reset("frame header write failed")
                self.disconnect()
                return False
            n2 = self._raw_write_chunked(framebuffer)
            if n2 != FB_SIZE:
                log(f"send_frame: 负载异常 n={n2}")
                self.request_reset("frame payload write failed")
                self.disconnect()
                return False
            return True

    def brightness_up(self):
        self.write(CMD_BRIGHTNESS_UP)

    def brightness_down(self):
        self.write(CMD_BRIGHTNESS_DOWN)


# ---------------------------------------------------------------------------
# 传感器
# ---------------------------------------------------------------------------

class SensorSampler:
    """周期性采集 snapshot（与 linux-compat.js fallbackStatus 字段一致）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._snapshot = self._blank_snapshot()
        self._prev_at = 0.0          # 上次采样时间
        self._prev_energy = None     # RAPL energy_uj 基线
        self._prev_disks = None      # 磁盘计数器基线
        self._prev_nets = None       # 网络计数器基线
        self._first_cpu = True       # cpu_percent 首采（无基线返回 0）

    def _blank_snapshot(self):
        return {
            "cpu_temp": 0.0, "cpu_usage": 0.0, "cpu_power": 0.0, "cpu_freq": 0.0,
            "gpu_temp": 0.0, "gpu_usage": 0.0, "gpu_power": 0.0, "gpu_freq": 0.0,
            "gpu_mem_used": 0.0, "gpu_mem_total": 0.0,
            "mem_used": 0.0, "mem_total": 0.0, "mem_percent": 0.0,
            "disks": [], "nets": [], "fans": [], "local_time": "",
        }

    def snapshot(self):
        with self._lock:
            return dict(self._snapshot)

    def sample(self):
        snap = self._blank_snapshot()

        # CPU 温度：coretemp / k10temp / cpu_thermal 取最高
        try:
            temps = psutil.sensors_temperatures()
            for key in ("coretemp", "k10temp", "cpu_thermal"):
                if key in temps and temps[key]:
                    snap["cpu_temp"] = round(max(t.current for t in temps[key]), 1)
                    break
        except Exception:
            pass

        # CPU 使用率（非阻塞差分）与频率（GHz）
        # 注意：psutil.cpu_percent(interval=None) 首次调用无基线返回 0.0，
        # 首采用 0.1s 阻塞采样获得真实值
        try:
            if self._first_cpu:
                snap["cpu_usage"] = round(psutil.cpu_percent(interval=0.1), 1)
                self._first_cpu = False
            else:
                snap["cpu_usage"] = round(psutil.cpu_percent(interval=None), 1)
        except Exception:
            pass
        try:
            freq = psutil.cpu_freq()
            if freq and freq.current:
                snap["cpu_freq"] = round(freq.current / 1000.0, 3)
        except Exception:
            pass

        # CPU 功耗：Intel RAPL energy_uj 差分
        try:
            path = "/sys/class/powercap/intel-rapl:0/energy_uj"
            if os.path.exists(path):
                with open(path) as fh:
                    energy = int(fh.read().strip())
                now = time.time()
                if self._prev_energy is not None and now - self._prev_at > 0.1:
                    dj = (energy - self._prev_energy) % (2 ** 64)
                    snap["cpu_power"] = round(dj / 1e6 / (now - self._prev_at), 1)
                self._prev_energy = energy
            else:
                self._prev_energy = None  # 文件消失时重置基线，恢复瞬间不产生假尖峰
        except Exception:
            pass

        # GPU：nvidia-smi（无 NVIDIA 时全 0）。
        # 注意 memory.used/total 单位是 MiB，消费方（linux-compat/overlay）按字节
        # 换算 GB，这里统一转字节（×1048576）。
        try:
            import subprocess
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,temperature.gpu,utilization.gpu,"
                 "power.draw,clocks.sm,memory.used,memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3).stdout.strip()
            if out:
                parts = [p.strip() for p in out.splitlines()[0].split(",")]
                snap["gpu_temp"] = float(parts[1]) if parts[1] else 0.0
                snap["gpu_usage"] = float(parts[2]) if parts[2] else 0.0
                snap["gpu_power"] = float(parts[3]) if parts[3] else 0.0
                snap["gpu_freq"] = float(parts[4]) if parts[4] else 0.0
                snap["gpu_mem_used"] = (float(parts[5]) if parts[5] else 0.0) * 1048576
                snap["gpu_mem_total"] = (float(parts[6]) if parts[6] else 0.0) * 1048576
        except Exception:
            pass

        # 内存
        try:
            mem = psutil.virtual_memory()
            snap["mem_total"] = mem.total
            snap["mem_used"] = mem.total - mem.available
            snap["mem_percent"] = round(mem.percent, 1)
        except Exception:
            pass

        # 磁盘 / 网络速率（计数器差分 bytes/s）
        now = time.time()
        cur_disks = None
        cur_nets = None
        try:
            cur_disks = psutil.disk_io_counters(perdisk=True)
        except Exception:
            pass
        try:
            cur_nets = psutil.net_io_counters(pernic=True)
        except Exception:
            pass
        if self._prev_disks is not None and self._prev_nets is not None:
            dt = max(now - self._prev_at, 0.001)
            rows = []
            for name, c in sorted((cur_disks or {}).items()):
                p = self._prev_disks.get(name)
                if p is None:
                    continue
                rows.append({
                    "name": name,
                    "read_bytes_s": max(0.0, (c.read_bytes - p.read_bytes) / dt),
                    "write_bytes_s": max(0.0, (c.write_bytes - p.write_bytes) / dt),
                })
            snap["disks"] = rows
            rows = []
            for name, c in sorted((cur_nets or {}).items()):
                p = self._prev_nets.get(name)
                if p is None:
                    continue
                rows.append({
                    "name": name,
                    "rx_bytes_s": max(0.0, (c.bytes_recv - p.bytes_recv) / dt),
                    "tx_bytes_s": max(0.0, (c.bytes_sent - p.bytes_sent) / dt),
                })
            snap["nets"] = rows
        self._prev_disks = cur_disks
        self._prev_nets = cur_nets
        self._prev_at = now

        # 风扇：/sys/class/hwmon 所有 fan*_input
        fans = []
        try:
            for hw in sorted(os.listdir("/sys/class/hwmon")):
                base = f"/sys/class/hwmon/{hw}"
                for entry in sorted(os.listdir(base)):
                    if entry.startswith("fan") and entry.endswith("_input"):
                        try:
                            with open(f"{base}/{entry}") as fh:
                                fans.append({"name": f"{hw}/{entry}", "rpm": int(fh.read().strip())})
                        except Exception:
                            pass
        except Exception:
            pass
        snap["fans"] = fans

        snap["local_time"] = time.strftime("%H:%M")

        with self._lock:
            self._snapshot = snap


# ---------------------------------------------------------------------------
# RGB565 转换
# ---------------------------------------------------------------------------

def png_to_framebuffer(png_bytes):
    """PNG → 320×240 RGB565 小端帧（tobytes 批量转换，比逐像素快）。"""
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    if img.size != (WIDTH, HEIGHT):
        img = img.resize((WIDTH, HEIGHT), Image.Resampling.BILINEAR)
    raw = img.tobytes()  # RGBRGB...
    fb = bytearray(FB_SIZE)
    # 每像素 3 字节 → 2 字节 RGB565 LE
    ri = 0
    wi = 0
    n = WIDTH * HEIGHT
    for _ in range(n):
        r = raw[ri]
        g = raw[ri + 1]
        b = raw[ri + 2]
        ri += 3
        rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
        fb[wi] = rgb565 & 0xFF
        fb[wi + 1] = (rgb565 >> 8) & 0xFF
        wi += 2
    return bytes(fb)


_BLACK_FB = bytes(FB_SIZE)


def black_framebuffer():
    return _BLACK_FB


# ---------------------------------------------------------------------------
# 主服务
# ---------------------------------------------------------------------------

class Daemon:
    def __init__(self, socket_path):
        self.socket_path = socket_path
        self.device = LMDevice()
        self.sampler = SensorSampler()
        self._state_lock = threading.Lock()
        self._mode = "monitor"       # monitor | image | zen
        self._frame = None           # image 模式帧（仅 frame_loop 写出）
        self._frame_seq = 0          # 缓存更新序号：有新图时 frame_loop 立即推
        self._running = True
        self._wake = threading.Event()

    # ---- 状态 ----

    def set_mode(self, mode, frame=None):
        with self._state_lock:
            self._mode = mode
            if frame is not None:
                self._frame = frame
                self._frame_seq += 1
        if frame is not None:
            self._wake.set()  # 唤醒 frame_loop 尽快推新帧

    def mode(self):
        with self._state_lock:
            return self._mode

    def handle(self, request):
        """处理一条 socket 请求，返回响应 dict。"""
        action = request.get("action")
        if action == "status":
            return {"ok": True, "mode": self.mode(),
                    "snapshot": self.sampler.snapshot()}
        if action == "monitor":
            self.set_mode("monitor")
            return {"ok": True, "mode": "monitor"}
        if action == "zen":
            # 待机 = 显示黑帧（视觉黑屏），不依赖硬件 zen 命令
            self.set_mode("zen")
            return {"ok": True, "mode": "zen"}
        if action == "image":
            try:
                data = request.get("data", "")
                if not data:
                    raise ValueError("缺少 data")
                png = base64.b64decode(data)
                fb = png_to_framebuffer(png)
            except Exception as exc:
                return {"ok": False, "mode": self.mode(), "error": f"image 解码失败: {exc}"}
            # 只更新缓存：USB 单写者 = frame_loop，避免与保活重发并发打设备
            self.set_mode("image", fb)
            return {"ok": True, "mode": "image"}
        if action == "brightness":
            direction = request.get("direction") or "up"
            if direction == "down":
                self.device.brightness_down()
            else:
                self.device.brightness_up()
            return {"ok": True, "mode": self.mode()}
        return {"ok": False, "mode": self.mode(),
                "error": f"未知动作: {action}"}

    # ---- 后台线程 ----

    def usb_loop(self):
        """连接 USB（设备可能晚出现，重试），掉线自动重连。
        reset 策略由 LMDevice（pending + 冷却 + 小时上限）控制。"""
        while self._running:
            if not self.device.connected:
                if not self.device.connect():
                    time.sleep(3)
                    continue
                self._wake.set()  # 连上后立刻推当前帧
            time.sleep(2)

    def frame_loop(self):
        """唯一 USB 推帧线程：image 最新缓存 / monitor·zen 黑帧。
        新 image 到达时尽快推；否则按 FRAME_INTERVAL 保活。
        写失败 → disconnect + request_reset → usb_loop 重连。"""
        fail_streak = 0
        last_sent_seq = -1
        while self._running:
            # 有新帧时短等；否则等保活周期（可被 _wake 提前打断）
            with self._state_lock:
                seq = self._frame_seq
                mode = self._mode
                fb = self._frame
            wait = 0.05 if (mode == "image" and seq != last_sent_seq) else FRAME_INTERVAL
            self._wake.wait(timeout=wait)
            self._wake.clear()
            if not self._running:
                break
            if not self.device.connected:
                continue
            with self._state_lock:
                seq = self._frame_seq
                mode = self._mode
                fb = self._frame
            if mode == "image":
                if fb is None:
                    continue
                ok = self.device.send_frame(fb)
            else:
                ok = self.device.send_frame(black_framebuffer())
            if ok:
                fail_streak = 0
                if mode == "image":
                    last_sent_seq = seq
            else:
                fail_streak += 1
                log(f"推帧失败 streak={fail_streak}")
                self.device.request_reset("frame_loop write failed")
                self.device.disconnect()
                time.sleep(min(2.0 + fail_streak, 10.0))

    def sample_loop(self):
        while self._running:
            self.sampler.sample()
            time.sleep(SAMPLE_INTERVAL)

    # ---- socket 服务 ----

    def serve(self):
        os.makedirs(os.path.dirname(self.socket_path), exist_ok=True)
        # 双实例保护：socket 已存在且可连接（活着的旧实例）→ 拒绝启动，
        # 避免 unlink 偷走旧实例的 socket。
        if os.path.exists(self.socket_path):
            try:
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                probe.settimeout(1)
                probe.connect(self.socket_path)
                probe.close()
                log("检测到已运行的 daemon（socket 活跃），退出")
                return
            except OSError:
                pass  # 残留死 socket，可安全 unlink
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        # 0660 root:deepcool：默认仅 root / deepcool 组成员可连。
        # 另：对 deepcool 组内每个用户写 POSIX ACL (u:name:rw)。
        # 原因：usermod -aG 后若不注销，登录会话的凭证里永远没有 deepcool，
        # id/groups 无该组，仅靠 0660 组位会 EACCES；ACL 按 UID 授权，
        # 不依赖会话是否已加载 supplementary group。
        try:
            gid = grp.getgrnam("deepcool").gr_gid
            os.chown(self.socket_path, 0, gid)
        except KeyError:
            log("警告: 用户组 deepcool 不存在，socket 将仅 root 可写（请运行 install-daemon.sh）")
        except OSError as exc:
            log("警告: chown deepcool 失败:", exc)
        os.chmod(self.socket_path, 0o660)
        self._apply_socket_acl(self.socket_path)
        server.listen(8)
        log(f"socket 就绪: {self.socket_path} (0660+ACL)")

        while self._running:
            try:
                conn, _ = server.accept()
            except OSError as exc:
                # 瞬时错误（EMFILE 等）不应杀死 daemon，记录后继续
                log("accept 失败（继续）:", exc)
                time.sleep(0.5)
                continue
            threading.Thread(target=self._serve_conn, args=(conn,), daemon=True).start()
        server.close()
        try:
            os.unlink(self.socket_path)
        except OSError:
            pass

    @staticmethod
    def _apply_socket_acl(path):
        """给 deepcool 组成员加 user ACL，使未 re-login 的会话也能 connect。"""
        try:
            members = list(grp.getgrnam("deepcool").gr_mem)
        except KeyError:
            members = []
        if not members:
            return
        try:
            import subprocess
            # -m 可多次；合并为一次 setfacl 调用
            specs = [f"u:{name}:rw" for name in members if name and name != "root"]
            if not specs:
                return
            cmd = ["setfacl", "-m", ",".join(specs), path]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if r.returncode != 0:
                log("setfacl 警告:", (r.stderr or r.stdout or "").strip() or r.returncode)
            else:
                log("socket ACL:", ",".join(specs))
        except FileNotFoundError:
            log("警告: 无 setfacl，未 re-login 的用户可能无法连接 socket（pacman -S acl）")
        except Exception as exc:
            log("setfacl 失败:", exc)

    def _serve_conn(self, conn):
        try:
            conn.settimeout(30)  # 客户端不半关闭/不发送时防止线程永久占住
            chunks = []
            total = 0
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_MSG:
                    raise ValueError("请求过大")
                chunks.append(chunk)
            body = b"".join(chunks).decode("utf-8")
            if not body.strip():
                return
            request = json.loads(body)
            response = self.handle(request)
            conn.sendall(json.dumps(response).encode("utf-8"))
        except Exception as exc:
            log("socket 请求处理失败:", exc)
            try:
                conn.sendall(json.dumps({
                    "ok": False, "mode": self.mode(), "error": str(exc),
                    "snapshot": self.sampler.snapshot(),
                }).encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def stop(self):
        self._running = False


def main():
    parser = argparse.ArgumentParser(description="DeepCool LM-Series LCD daemon")
    parser.add_argument("--socket", default="/run/deepcool-lm/deepcool-lm.sock",
                        help="Unix socket 路径（默认 /run/deepcool-lm/deepcool-lm.sock）")
    parser.add_argument("--foreground", action="store_true", help="前台运行（默认）")
    args = parser.parse_args()

    daemon = Daemon(args.socket)
    threads = [
        threading.Thread(target=daemon.usb_loop, daemon=True),
        threading.Thread(target=daemon.frame_loop, daemon=True),
        threading.Thread(target=daemon.sample_loop, daemon=True),
    ]
    for t in threads:
        t.start()
    try:
        daemon.serve()
    except KeyboardInterrupt:
        pass
    finally:
        daemon.stop()
        daemon.device.disconnect()
        log("daemon 退出")


if __name__ == "__main__":
    main()
