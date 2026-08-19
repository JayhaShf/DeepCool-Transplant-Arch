import base64
import importlib.util
import io
import pathlib
import tempfile
import threading
import time
import unittest

from PIL import Image


DAEMON_PATH = pathlib.Path(__file__).resolve().parents[1] / "deepcool-lm-daemon.py"
SPEC = importlib.util.spec_from_file_location("deepcool_lm_daemon", DAEMON_PATH)
daemon_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(daemon_module)


class FakeDevice:
    def __init__(self, connected=False, send_ok=True):
        self.connected = connected
        self.send_ok = send_ok
        self.frames = []
        self.disconnected = False

    def status(self):
        return {
            "connected": self.connected,
            "generation": 1 if self.connected else 0,
            "last_error": None if self.connected else "offline",
            "last_write_ok": self.send_ok if self.frames else None,
            "last_write_at": None,
            "last_write_kind": "frame" if self.frames else None,
            "reset_pending": False,
            "resets_last_hour": 0,
        }

    def connect(self):
        self.connected = True
        return True

    def send_frame(self, frame):
        self.frames.append(frame)
        return self.send_ok

    def request_reset(self, _reason=""):
        pass

    def disconnect(self):
        self.connected = False
        self.disconnected = True

    def brightness_up(self):
        return self.connected

    def brightness_down(self):
        return self.connected


class FakeSampler:
    def __init__(self):
        self.samples = 0

    def snapshot(self):
        return {"cpu_temp": 42.0}

    def sample(self):
        self.samples += 1


def png_base64(size=(320, 240)):
    output = io.BytesIO()
    Image.new("RGB", size, "#123456").save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode("ascii")


class ImageBoundaryTests(unittest.TestCase):
    def test_valid_png_converts_to_fixed_framebuffer(self):
        raw = daemon_module.decode_image_data(png_base64())
        frame = daemon_module.png_to_framebuffer(raw)
        self.assertEqual(len(frame), daemon_module.FB_SIZE)

    def test_invalid_base64_and_non_png_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "base64"):
            daemon_module.decode_image_data("%%%")
        fake = base64.b64encode(b"not a png").decode("ascii")
        with self.assertRaisesRegex(ValueError, "PNG"):
            daemon_module.decode_image_data(fake)

    def test_dimensions_are_rejected_before_pillow_decode(self):
        header = bytearray(daemon_module.PNG_SIGNATURE + b"\x00\x00\x00\rIHDR")
        header += (5000).to_bytes(4, "big") + (100).to_bytes(4, "big") + b"\x08\x02\x00\x00\x00"
        header += b"\x00\x00\x00\x00"
        encoded = base64.b64encode(header).decode("ascii")
        with self.assertRaisesRegex(ValueError, "单边"):
            daemon_module.decode_image_data(encoded)

    def test_encoded_size_limit_is_enforced_before_decode(self):
        oversized = "A" * ((((daemon_module.MAX_PNG_BYTES + 2) // 3) * 4) + 1)
        with self.assertRaisesRegex(ValueError, "超过上限"):
            daemon_module.decode_image_data(oversized)


class ProtocolTests(unittest.TestCase):
    def make_daemon(self, connected=False, send_ok=True):
        device = FakeDevice(connected=connected, send_ok=send_ok)
        daemon = daemon_module.Daemon(
            "/tmp/not-used.sock", device=device, sampler=FakeSampler()
        )
        return daemon, device

    def test_status_preserves_compat_fields_and_separates_health(self):
        daemon, _ = self.make_daemon(connected=False)
        response = daemon.handle({"action": "status"})
        self.assertTrue(response["ok"])
        self.assertTrue(response["daemon_online"])
        self.assertEqual(response["mode"], "monitor")
        self.assertIn("snapshot", response)
        self.assertFalse(response["device_connected"])
        self.assertIn("workers", response)
        self.assertIn("last_write_ok", response)

    def test_image_returns_sequence_and_optional_delivery_confirmation(self):
        daemon, _ = self.make_daemon(connected=True)

        def deliver():
            while daemon._frame_seq == 0:
                time.sleep(0.005)
            daemon._record_frame_result(daemon._frame_seq, "image", True)

        thread = threading.Thread(target=deliver)
        thread.start()
        response = daemon.handle({
            "action": "image", "data": png_base64(), "confirm_timeout_ms": 500,
        })
        thread.join(timeout=1)
        self.assertTrue(response["ok"])
        self.assertTrue(response["accepted"])
        self.assertEqual(response["seq"], 1)
        self.assertTrue(response["delivered"])

    def test_bad_image_does_not_change_mode(self):
        daemon, _ = self.make_daemon()
        response = daemon.handle({"action": "image", "data": "%%%"})
        self.assertFalse(response["ok"])
        self.assertFalse(response["accepted"])
        self.assertEqual(daemon.mode(), "monitor")

    def test_brightness_reports_disconnected_device(self):
        daemon, _ = self.make_daemon(connected=False)
        response = daemon.handle({"action": "brightness", "direction": "up"})
        self.assertFalse(response["ok"])
        self.assertFalse(response["delivered"])


class LifecycleTests(unittest.TestCase):
    def test_instance_lock_is_acquired_before_workers(self):
        with tempfile.TemporaryDirectory() as tmp:
            socket_path = str(pathlib.Path(tmp) / "daemon.sock")
            lock_path = str(pathlib.Path(tmp) / "daemon.lock")
            first = daemon_module.Daemon(
                socket_path, lock_path=lock_path,
                device=FakeDevice(), sampler=FakeSampler(),
            )
            second = daemon_module.Daemon(
                socket_path, lock_path=lock_path,
                device=FakeDevice(), sampler=FakeSampler(),
            )
            try:
                first.prepare_server()
                with self.assertRaises(daemon_module.AlreadyRunningError):
                    second.prepare_server()
                self.assertEqual(first._worker_threads, [])
            finally:
                second.shutdown()
                first.shutdown()

    def test_reset_budget_survives_process_object_recreation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(pathlib.Path(tmp) / "reset.json")
            first = daemon_module.LMDevice(path)
            first._record_reset()
            second = daemon_module.LMDevice(path)
            self.assertEqual(second.status()["resets_last_hour"], 1)


if __name__ == "__main__":
    unittest.main()
