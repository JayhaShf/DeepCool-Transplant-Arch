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
      {"action": "image", "data": "<png base64>"}           → 接受图片并返回 seq/delivered
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
        * 启动先直接 claim；仅真实失败后 reset，预算跨进程重启持久化

  - 无内置 web API（8642 已按用户要求移除）；lcd.json 由 install 脚本直接写入。

用法（systemd 由 daemon/deepcool-lm-daemon.service 管理）：
    sudo python3 deepcool-lm-daemon.py [--socket /run/deepcool-lm/deepcool-lm.sock]
"""

import argparse
import base64
import binascii
import fcntl
import grp
import io
import json
import os
import signal
import socket
import stat
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
RESET_ATTEMPT_COOLDOWN = 30.0
MAX_PNG_BYTES = 2 * 1024 * 1024
MAX_SOURCE_PIXELS = 4_000_000
MAX_SOURCE_DIMENSION = 4096
MAX_MSG = 3 * 1024 * 1024
MAX_CONNECTIONS = 8
CONNECTION_TIMEOUT = 5.0
MAX_CONFIRM_TIMEOUT_MS = 2000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


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

    def __init__(self, reset_state_path=None):
        self._dev = None
        self._io_lock = threading.RLock()
        self._state_lock = threading.Lock()
        self._connect_generation = 0
        self._claimed = False
        self._detached = False
        # 启动先直接 claim；只有真实 claim/write 失败才申请 reset。
        self._pending_reset = False
        self._last_reset_at = 0.0
        self._last_reset_attempt_at = 0.0
        self._reset_times = []
        self._reset_state_path = reset_state_path
        self._last_error = None
        self._last_write_ok = None
        self._last_write_at = None
        self._last_write_kind = None
        self._load_reset_state()

    @property
    def connected(self):
        with self._state_lock:
            return self._dev is not None

    def status(self):
        now = time.time()
        with self._state_lock:
            resets = [t for t in self._reset_times if 0 <= now - t < 3600]
            return {
                "connected": self._dev is not None,
                "generation": self._connect_generation,
                "last_error": self._last_error,
                "last_write_ok": self._last_write_ok,
                "last_write_at": self._last_write_at,
                "last_write_kind": self._last_write_kind,
                "reset_pending": self._pending_reset,
                "resets_last_hour": len(resets),
            }

    def _set_error(self, error):
        with self._state_lock:
            self._last_error = str(error) if error else None

    def _mark_write(self, kind, ok, error=None):
        with self._state_lock:
            self._last_write_kind = kind
            self._last_write_ok = bool(ok)
            self._last_write_at = time.time()
            self._last_error = str(error) if error else None

    def _load_reset_state(self):
        if not self._reset_state_path:
            return
        try:
            with open(self._reset_state_path, encoding="utf-8") as fh:
                data = json.load(fh)
            now = time.time()
            times = [float(t) for t in data.get("reset_times", [])]
            self._reset_times = [t for t in times if 0 <= now - t < 3600]
            self._last_reset_at = max(self._reset_times, default=0.0)
        except FileNotFoundError:
            pass
        except Exception as exc:
            log("读取 USB reset 状态失败（忽略损坏状态）:", exc)

    def _save_reset_state(self):
        if not self._reset_state_path:
            return
        path = self._reset_state_path
        tmp = f"{path}.tmp.{os.getpid()}"
        try:
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            with self._state_lock:
                payload = {"reset_times": list(self._reset_times)}
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, separators=(",", ":"))
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
            os.chmod(path, 0o600)
        except Exception as exc:
            log("保存 USB reset 状态失败:", exc)
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def request_reset(self, reason=""):
        """标记下次 connect 需要 reset（写失败时调用）。"""
        with self._state_lock:
            newly_pending = not self._pending_reset
            self._pending_reset = True
        if reason and newly_pending:
            log("请求下次 USB reset:", reason)

    def _take_reset_request(self):
        now = time.time()
        with self._state_lock:
            if not self._pending_reset:
                return False
            self._reset_times = [t for t in self._reset_times if 0 <= now - t < 3600]
            if len(self._reset_times) >= MAX_RESETS_PER_HOUR:
                reason = f"已达每小时上限 {MAX_RESETS_PER_HOUR}"
            elif now - self._last_reset_at < RESET_COOLDOWN:
                reason = f"成功 reset 冷却中（{RESET_COOLDOWN:.0f}s）"
            elif now - self._last_reset_attempt_at < RESET_ATTEMPT_COOLDOWN:
                reason = f"失败尝试退避中（{RESET_ATTEMPT_COOLDOWN:.0f}s）"
            else:
                self._last_reset_attempt_at = now
                return True
        log("USB reset 暂缓:", reason)
        return False

    def _record_reset(self):
        now = time.time()
        with self._state_lock:
            self._last_reset_at = now
            self._reset_times = [t for t in self._reset_times if 0 <= now - t < 3600]
            self._reset_times.append(now)
            self._pending_reset = False
        self._save_reset_state()

    def connect(self):
        """打开设备。仅在 _pending_reset 且通过限流时总线复位。"""
        try:
            import usb.core
            import usb.util
        except ImportError:
            log("pyusb 未安装（sudo pacman -S python-pyusb）")
            self._set_error("python-pyusb is not installed")
            return False
        with self._io_lock:
            self._disconnect_locked()
            dev = None
            claimed = False
            detached = False
            reset_done = False
            try:
                dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
                if dev is None:
                    self._set_error("USB device 3633:0026 not found")
                    return False
                if self._take_reset_request():
                    try:
                        dev.reset()
                        reset_done = True
                        log("USB reset 已发送，等待重枚举…")
                    except Exception as exc:
                        log("USB reset 失败，尝试 sysfs reauth:", exc)
                        reset_done = self._sysfs_reauth()
                    if reset_done:
                        self._record_reset()
                        try:
                            usb.util.dispose_resources(dev)
                        except Exception:
                            pass
                        time.sleep(1.5)
                        dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
                        if dev is None:
                            self._set_error("device missing after USB reset/reauth")
                            return False
                try:
                    if dev.is_kernel_driver_active(0):
                        dev.detach_kernel_driver(0)
                        detached = True
                except Exception:
                    pass
                try:
                    dev.set_configuration()
                except Exception as exc:
                    log("set_configuration:", exc)
                try:
                    usb.util.claim_interface(dev, 0)
                    claimed = True
                except Exception as exc:
                    self._set_error(f"claim_interface failed: {exc}")
                    self.request_reset("claim_interface failed")
                    log("claim_interface 失败:", exc)
                    self._cleanup_external_device(dev, claimed, detached)
                    return False
                with self._state_lock:
                    self._dev = dev
                    self._claimed = claimed
                    self._detached = detached
                    self._connect_generation += 1
                    generation = self._connect_generation
                    self._last_error = None
                log(f"USB 已连接 (gen={generation}, reset={reset_done})")
                time.sleep(CONNECT_SETTLE)
                n = self._raw_write_locked(CMD_INIT_QUERY)
                if n != len(CMD_INIT_QUERY):
                    self._mark_write("init", False, "INIT_QUERY write failed")
                    self.request_reset("INIT_QUERY write failed")
                    self._disconnect_locked()
                    return False
                self._mark_write("init", True)
                with self._state_lock:
                    self._pending_reset = False
                time.sleep(0.15)
                return True
            except Exception as exc:
                self._set_error(f"USB connect failed: {exc}")
                if dev is not None and dev is not self._dev:
                    self._cleanup_external_device(dev, claimed, detached)
                self._disconnect_locked()
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
                return True
        except Exception as exc:
            log("sysfs reauth 失败:", exc)
        return False

    @staticmethod
    def _cleanup_external_device(dev, claimed, detached):
        try:
            import usb.util
        except Exception:
            return
        if claimed:
            try:
                usb.util.release_interface(dev, 0)
            except Exception:
                pass
        if detached:
            try:
                dev.attach_kernel_driver(0)
            except Exception as exc:
                log("重新挂接 kernel driver 失败:", exc)
        try:
            usb.util.dispose_resources(dev)
        except Exception:
            pass

    def _disconnect_locked(self):
        with self._state_lock:
            dev, self._dev = self._dev, None
            claimed, self._claimed = self._claimed, False
            detached, self._detached = self._detached, False
        if dev is not None:
            self._cleanup_external_device(dev, claimed, detached)

    def disconnect(self):
        with self._io_lock:
            self._disconnect_locked()

    def _raw_write_locked(self, data):
        if self._dev is None:
            return 0
        try:
            return self._dev.write(EP_OUT, data, timeout=5000)
        except Exception as exc:
            log("USB 写入失败:", exc)
            self._set_error(f"USB write failed: {exc}")
            self._disconnect_locked()
            return 0

    def _raw_write_chunked_locked(self, data):
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
                    self._disconnect_locked()
                    return total + max(n, 0)
                total += n
            return total
        except Exception as exc:
            log("USB 分包写入失败:", exc)
            self._set_error(f"USB chunked write failed: {exc}")
            self._disconnect_locked()
            return total

    def write(self, data, kind="command"):
        """带锁写小命令（亮度等）。"""
        with self._io_lock:
            if self._dev is None:
                self._mark_write(kind, False, "USB device is disconnected")
                return False
            n = self._raw_write_locked(data)
            ok = n == len(data)
            self._mark_write(kind, ok, None if ok else f"short USB write: {n}/{len(data)}")
            if not ok:
                self.request_reset(f"{kind} write failed")
            return ok

    def send_frame(self, framebuffer):
        """帧头 + 512B 分包负载，同一把锁内完成。失败返回 False。"""
        if framebuffer is None or len(framebuffer) != FB_SIZE:
            log(f"send_frame: 非法帧长度 {0 if framebuffer is None else len(framebuffer)}")
            return False
        with self._io_lock:
            if self._dev is None:
                self._mark_write("frame", False, "USB device is disconnected")
                return False
            n1 = self._raw_write_locked(FRAME_HEADER)
            if n1 != len(FRAME_HEADER):
                log(f"send_frame: 帧头异常 n={n1}")
                self._mark_write("frame", False, f"frame header write: {n1}/{len(FRAME_HEADER)}")
                self.request_reset("frame header write failed")
                self._disconnect_locked()
                return False
            n2 = self._raw_write_chunked_locked(framebuffer)
            if n2 != FB_SIZE:
                log(f"send_frame: 负载异常 n={n2}")
                self._mark_write("frame", False, f"frame payload write: {n2}/{FB_SIZE}")
                self.request_reset("frame payload write failed")
                self._disconnect_locked()
                return False
            self._mark_write("frame", True)
            return True

    def brightness_up(self):
        return self.write(CMD_BRIGHTNESS_UP, "brightness_up")

    def brightness_down(self):
        return self.write(CMD_BRIGHTNESS_DOWN, "brightness_down")


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

def decode_image_data(data):
    """严格解码 JSON 中的 PNG base64，并在进入 Pillow 前验证硬上限。"""
    if not isinstance(data, str) or not data:
        raise ValueError("data 必须是非空 base64 字符串")
    max_encoded = ((MAX_PNG_BYTES + 2) // 3) * 4
    if len(data) > max_encoded:
        raise ValueError(f"PNG base64 超过上限 {max_encoded} 字符")
    try:
        encoded = data.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("base64 只能包含 ASCII 字符") from exc
    try:
        png_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("base64 格式无效") from exc
    if len(png_bytes) > MAX_PNG_BYTES:
        raise ValueError(f"PNG 超过上限 {MAX_PNG_BYTES} 字节")
    if not png_bytes.startswith(PNG_SIGNATURE):
        raise ValueError("仅接受 PNG 文件")
    if len(png_bytes) < 33 or png_bytes[12:16] != b"IHDR":
        raise ValueError("PNG 缺少有效 IHDR")
    width = int.from_bytes(png_bytes[16:20], "big")
    height = int.from_bytes(png_bytes[20:24], "big")
    if width <= 0 or height <= 0:
        raise ValueError("PNG 尺寸无效")
    if width > MAX_SOURCE_DIMENSION or height > MAX_SOURCE_DIMENSION:
        raise ValueError(f"PNG 单边不得超过 {MAX_SOURCE_DIMENSION} 像素")
    if width * height > MAX_SOURCE_PIXELS:
        raise ValueError(f"PNG 总像素不得超过 {MAX_SOURCE_PIXELS}")
    return png_bytes


def png_to_framebuffer(png_bytes):
    """受限 PNG → 320×240 RGB565 小端帧。"""
    with Image.open(io.BytesIO(png_bytes)) as probe:
        if probe.format != "PNG":
            raise ValueError("仅接受 PNG 文件")
        if probe.size[0] * probe.size[1] > MAX_SOURCE_PIXELS:
            raise ValueError(f"PNG 总像素不得超过 {MAX_SOURCE_PIXELS}")
        if getattr(probe, "n_frames", 1) != 1:
            raise ValueError("不接受动画 PNG")
        probe.verify()
    with Image.open(io.BytesIO(png_bytes)) as source:
        source.load()
        if source.size != (WIDTH, HEIGHT):
            img = source.resize((WIDTH, HEIGHT), Image.Resampling.BILINEAR).convert("RGB")
        else:
            img = source.convert("RGB")
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

class AlreadyRunningError(RuntimeError):
    pass


class Daemon:
    WORKER_NAMES = ("usb", "frame", "sample")

    def __init__(self, socket_path, lock_path=None, reset_state_path=None,
                 device=None, sampler=None):
        self.socket_path = os.path.abspath(socket_path)
        self.lock_path = lock_path or os.path.join(os.path.dirname(self.socket_path), "daemon.lock")
        self.device = device if device is not None else LMDevice(reset_state_path)
        self.sampler = sampler if sampler is not None else SensorSampler()
        self._state_lock = threading.RLock()
        self._frame_condition = threading.Condition(self._state_lock)
        self._mode = "monitor"
        self._frame = None
        self._frame_seq = 0
        self._sent_seq = 0
        self._last_frame_write_ok = None
        self._last_frame_write_at = None
        self._last_frame_error = None
        self._stop_event = threading.Event()
        self._wake = threading.Event()
        self._workers = {
            name: {"alive": False, "error": None, "started_at": None}
            for name in self.WORKER_NAMES
        }
        self._worker_threads = []
        self._fatal_worker = None
        self._server = None
        self._socket_inode = None
        self._lock_fd = None
        self._connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._connection_lock = threading.Lock()
        self._connection_threads = set()
        self._active_connections = 0

    # ---- 状态 ----

    def set_mode(self, mode, frame=None):
        with self._frame_condition:
            self._mode = mode
            if frame is not None:
                self._frame = frame
                self._frame_seq += 1
            seq = self._frame_seq
        self._wake.set()
        return seq

    def mode(self):
        with self._state_lock:
            return self._mode

    def _device_status(self):
        status_method = getattr(self.device, "status", None)
        if callable(status_method):
            status = status_method()
            if isinstance(status, dict):
                return dict(status)
        return {
            "connected": bool(getattr(self.device, "connected", False)),
            "generation": 0,
            "last_error": None,
            "last_write_ok": None,
            "last_write_at": None,
            "last_write_kind": None,
            "reset_pending": False,
            "resets_last_hour": 0,
        }

    def _worker_status(self):
        with self._state_lock:
            workers = {name: dict(value) for name, value in self._workers.items()}
            fatal = self._fatal_worker
        workers_ok = all(value["alive"] and not value["error"] for value in workers.values())
        return workers, workers_ok, fatal

    def _frame_status(self):
        with self._state_lock:
            return {
                "accepted_seq": self._frame_seq,
                "sent_seq": self._sent_seq,
                "last_write_ok": self._last_frame_write_ok,
                "last_write_at": self._last_frame_write_at,
                "last_error": self._last_frame_error,
            }

    def status_response(self):
        device = self._device_status()
        workers, workers_ok, fatal = self._worker_status()
        frame = self._frame_status()
        with self._connection_lock:
            active_connections = self._active_connections
        connected = bool(device.get("connected"))
        return {
            # ok 表示协议请求成功；硬件/worker 健康度使用独立字段。
            "ok": True,
            "daemon_online": True,
            "mode": self.mode(),
            "snapshot": self.sampler.snapshot(),
            "device_connected": connected,
            "workers_ok": workers_ok,
            "last_write_ok": device.get("last_write_ok"),
            "last_write_at": device.get("last_write_at"),
            "last_write_kind": device.get("last_write_kind"),
            "last_write_error": device.get("last_error"),
            "accepted_seq": frame["accepted_seq"],
            "sent_seq": frame["sent_seq"],
            "healthy": connected and workers_ok and fatal is None,
            "device": device,
            "workers": workers,
            "frame": frame,
            "active_connections": active_connections,
            "max_connections": MAX_CONNECTIONS,
        }

    def wait_for_delivery(self, seq, timeout_ms):
        deadline = time.monotonic() + timeout_ms / 1000.0
        with self._frame_condition:
            while self._sent_seq < seq and not self._stop_event.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._frame_condition.wait(remaining)
            return self._sent_seq >= seq

    @staticmethod
    def _confirm_timeout(request):
        value = request.get("confirm_timeout_ms", request.get("wait_ms", 0))
        if value == 0 and request.get("wait") is True:
            value = 1000
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("confirm_timeout_ms 必须是数字")
        if value < 0 or value > MAX_CONFIRM_TIMEOUT_MS:
            raise ValueError(f"confirm_timeout_ms 必须在 0..{MAX_CONFIRM_TIMEOUT_MS}")
        return int(value)

    def handle(self, request):
        """处理一条 socket 请求，返回兼容响应 dict。"""
        if not isinstance(request, dict):
            return {"ok": False, "mode": self.mode(), "error": "请求必须是 JSON object"}
        action = request.get("action")
        if action == "status":
            return self.status_response()
        if action == "monitor":
            self.set_mode("monitor")
            return {"ok": True, "mode": "monitor"}
        if action == "zen":
            self.set_mode("zen")
            return {"ok": True, "mode": "zen"}
        if action == "image":
            try:
                timeout_ms = self._confirm_timeout(request)
                png = decode_image_data(request.get("data"))
                fb = png_to_framebuffer(png)
            except Exception as exc:
                return {
                    "ok": False, "mode": self.mode(), "accepted": False,
                    "delivered": False, "error": f"image 解码失败: {exc}",
                }
            seq = self.set_mode("image", fb)
            delivered = (self.wait_for_delivery(seq, timeout_ms) if timeout_ms
                         else self._frame_status()["sent_seq"] >= seq)
            return {
                "ok": True,
                "mode": "image",
                "accepted": True,
                "seq": seq,
                "accepted_seq": seq,
                "delivered": delivered,
            }
        if action == "brightness":
            direction = request.get("direction") or "up"
            if direction not in ("up", "down"):
                return {"ok": False, "mode": self.mode(), "error": "direction 必须是 up 或 down"}
            ok = self.device.brightness_down() if direction == "down" else self.device.brightness_up()
            response = {"ok": bool(ok), "mode": self.mode(), "delivered": bool(ok)}
            if not ok:
                response["error"] = self._device_status().get("last_error") or "USB 写入失败"
            return response
        return {"ok": False, "mode": self.mode(), "error": f"未知动作: {action}"}

    # ---- 后台线程 ----

    def _worker_entry(self, name, target):
        with self._state_lock:
            self._workers[name].update(alive=True, error=None, started_at=time.time())
        try:
            target()
        except Exception as exc:
            if not self._stop_event.is_set():
                error = f"{type(exc).__name__}: {exc}"
                with self._state_lock:
                    self._workers[name]["error"] = error
                    self._fatal_worker = {"name": name, "error": error, "at": time.time()}
                log(f"关键 worker {name} 异常退出:", error)
                self.stop()
        finally:
            with self._state_lock:
                self._workers[name]["alive"] = False

    def start_workers(self):
        if self._server is None or self._lock_fd is None:
            raise RuntimeError("必须先 prepare_server，再启动硬件 worker")
        targets = {
            "usb": self.usb_loop,
            "frame": self.frame_loop,
            "sample": self.sample_loop,
        }
        for name in self.WORKER_NAMES:
            thread = threading.Thread(
                target=self._worker_entry, args=(name, targets[name]),
                name=f"deepcool-{name}", daemon=True,
            )
            self._worker_threads.append(thread)
            thread.start()

    def usb_loop(self):
        """设备晚出现时指数退避；只有真实失败才会请求 reset。"""
        retry = 1.0
        while not self._stop_event.is_set():
            if not self.device.connected:
                if not self.device.connect():
                    if self._stop_event.wait(retry):
                        break
                    retry = min(retry * 2.0, 30.0)
                    continue
                retry = 1.0
                self._wake.set()
            self._stop_event.wait(2.0)

    def _record_frame_result(self, seq, mode, ok, error=None):
        with self._frame_condition:
            self._last_frame_write_ok = bool(ok)
            self._last_frame_write_at = time.time()
            self._last_frame_error = str(error) if error else None
            if ok and mode == "image":
                self._sent_seq = max(self._sent_seq, seq)
            self._frame_condition.notify_all()

    def frame_loop(self):
        """唯一 USB 推帧线程：image 最新缓存 / monitor·zen 黑帧。"""
        fail_streak = 0
        last_sent_seq = -1
        while not self._stop_event.is_set():
            with self._state_lock:
                seq = self._frame_seq
                mode = self._mode
            wait = 0.05 if (mode == "image" and seq != last_sent_seq) else FRAME_INTERVAL
            self._wake.wait(timeout=wait)
            self._wake.clear()
            if self._stop_event.is_set():
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
                self._record_frame_result(seq, mode, True)
            else:
                fail_streak += 1
                error = self._device_status().get("last_error") or "frame write failed"
                self._record_frame_result(seq, mode, False, error)
                log(f"推帧失败 streak={fail_streak}")
                self.device.request_reset("frame_loop write failed")
                self.device.disconnect()
                self._stop_event.wait(min(2.0 + fail_streak, 10.0))

    def sample_loop(self):
        while not self._stop_event.is_set():
            self.sampler.sample()
            self._stop_event.wait(SAMPLE_INTERVAL)

    # ---- 实例锁与 socket 服务 ----

    def _acquire_instance_lock(self):
        os.makedirs(os.path.dirname(self.lock_path), mode=0o750, exist_ok=True)
        fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o640)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(fd)
            raise AlreadyRunningError(f"已有 daemon 持有实例锁 {self.lock_path}") from exc
        os.ftruncate(fd, 0)
        os.fchmod(fd, 0o640)
        os.write(fd, f"{os.getpid()}\n".encode("ascii"))
        os.fsync(fd)
        self._lock_fd = fd

    def prepare_server(self):
        """先取得全局实例锁并绑定 socket；成功后才允许启动 USB worker。"""
        self._acquire_instance_lock()
        socket_dir = os.path.dirname(self.socket_path)
        os.makedirs(socket_dir, mode=0o750, exist_ok=True)
        if os.path.lexists(self.socket_path):
            st = os.lstat(self.socket_path)
            if not stat.S_ISSOCK(st.st_mode):
                raise RuntimeError(f"拒绝删除非 socket 路径: {self.socket_path}")
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.settimeout(1)
                probe.connect(self.socket_path)
            except OSError:
                os.unlink(self.socket_path)
            else:
                raise AlreadyRunningError(f"已有 daemon 监听 {self.socket_path}")
            finally:
                probe.close()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(self.socket_path)
            try:
                gid = grp.getgrnam("deepcool").gr_gid
                os.chown(self.socket_path, -1, gid)
            except KeyError:
                log("警告: deepcool 组不存在，socket 将仅当前用户可访问")
            except OSError as exc:
                log("警告: socket chgrp deepcool 失败:", exc)
            os.chmod(self.socket_path, 0o660)
            server.listen(MAX_CONNECTIONS)
            server.settimeout(1.0)
            self._socket_inode = os.stat(self.socket_path).st_ino
            self._server = server
            log(f"socket 就绪: {self.socket_path} (0660, max={MAX_CONNECTIONS})")
        except Exception:
            server.close()
            raise

    @staticmethod
    def _send_busy(conn):
        try:
            conn.settimeout(0.25)
            conn.sendall(json.dumps({
                "ok": False, "daemon_online": True,
                "error": "服务繁忙，请稍后重试",
            }).encode("utf-8"))
        except OSError:
            pass
        finally:
            conn.close()

    def _serve_conn_guarded(self, conn):
        current = threading.current_thread()
        try:
            self._serve_conn(conn)
        finally:
            with self._connection_lock:
                self._active_connections -= 1
                self._connection_threads.discard(current)
            self._connection_slots.release()

    def _serve_conn(self, conn):
        try:
            conn.settimeout(CONNECTION_TIMEOUT)
            chunks = []
            total = 0
            while True:
                chunk = conn.recv(min(65536, MAX_MSG - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_MSG:
                    raise ValueError(f"请求超过 {MAX_MSG} 字节")
                chunks.append(chunk)
            body = b"".join(chunks).decode("utf-8")
            if not body.strip():
                return
            request = json.loads(body)
            if not isinstance(request, dict):
                raise ValueError("请求必须是 JSON object")
            conn.sendall(json.dumps(self.handle(request)).encode("utf-8"))
        except Exception as exc:
            log("socket 请求处理失败:", exc)
            try:
                conn.sendall(json.dumps({
                    "ok": False, "daemon_online": True, "mode": self.mode(),
                    "error": str(exc), "snapshot": self.sampler.snapshot(),
                }).encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def serve(self):
        if self._server is None:
            raise RuntimeError("server 尚未准备")
        server = self._server
        while not self._stop_event.is_set():
            try:
                conn, _ = server.accept()
            except socket.timeout:
                continue
            except OSError as exc:
                if self._stop_event.is_set():
                    break
                log("accept 失败（继续）:", exc)
                self._stop_event.wait(0.5)
                continue
            if not self._connection_slots.acquire(blocking=False):
                self._send_busy(conn)
                continue
            thread = threading.Thread(
                target=self._serve_conn_guarded, args=(conn,),
                name="deepcool-client", daemon=True,
            )
            with self._connection_lock:
                self._active_connections += 1
                self._connection_threads.add(thread)
            try:
                thread.start()
            except Exception:
                with self._connection_lock:
                    self._active_connections -= 1
                    self._connection_threads.discard(thread)
                self._connection_slots.release()
                self._send_busy(conn)
                raise
        with self._state_lock:
            fatal = self._fatal_worker
        if fatal is not None:
            raise RuntimeError(f"worker {fatal['name']} failed: {fatal['error']}")

    def stop(self):
        self._stop_event.set()
        self._wake.set()
        with self._frame_condition:
            self._frame_condition.notify_all()
        server, self._server = self._server, None
        if server is not None:
            try:
                server.close()
            except OSError:
                pass

    def shutdown(self):
        self.stop()
        for thread in self._worker_threads:
            thread.join(timeout=6)
        with self._connection_lock:
            connection_threads = list(self._connection_threads)
        for thread in connection_threads:
            thread.join(timeout=CONNECTION_TIMEOUT + 0.5)
        disconnect = getattr(self.device, "disconnect", None)
        if callable(disconnect):
            disconnect()
        try:
            if self._socket_inode is not None and os.path.lexists(self.socket_path):
                st = os.lstat(self.socket_path)
                if stat.S_ISSOCK(st.st_mode) and st.st_ino == self._socket_inode:
                    os.unlink(self.socket_path)
        except OSError:
            pass
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._lock_fd)
                self._lock_fd = None


def main():
    parser = argparse.ArgumentParser(description="DeepCool LM-Series LCD daemon")
    parser.add_argument("--socket", default="/run/deepcool-lm/deepcool-lm.sock",
                        help="Unix socket 路径")
    parser.add_argument("--lock", default="/run/deepcool-lm/daemon.lock",
                        help="全局实例锁路径")
    parser.add_argument("--reset-state", default="/var/lib/deepcool-lm/reset-state.json",
                        help="跨重启 USB reset 限流状态")
    parser.add_argument("--foreground", action="store_true", help="前台运行（兼容选项）")
    args = parser.parse_args()

    daemon = Daemon(args.socket, args.lock, args.reset_state)

    def handle_signal(signum, _frame):
        log(f"收到 signal {signum}，准备退出")
        daemon.stop()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    try:
        daemon.prepare_server()
        daemon.start_workers()
        daemon.serve()
        return 0
    except AlreadyRunningError as exc:
        log(exc)
        return 1
    except Exception as exc:
        log("daemon 致命错误:", exc)
        return 1
    finally:
        daemon.shutdown()
        log("daemon 退出")


if __name__ == "__main__":
    sys.exit(main())
