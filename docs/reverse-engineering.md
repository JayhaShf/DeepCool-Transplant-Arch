# DeepCool 1.2.12 逆向记录

目标：解包 / 反编译 `DeepCool-1.2.12-setup.exe`，在 Linux 上运行。

## 1. 安装包结构

```
DeepCool-1.2.12-setup.exe  (505 MB, NSIS)
└── app/                          (7z 直接可解出)
    ├── DeepCool.exe              (Electron 启动器, Windows)
    ├── resources/
    │   ├── app.asar              (327 MB, Electron 应用包, 无头 zip)
    │   ├── app.asar.unpacked/    (原生 .node 模块, PE32 DLL)
    │   └── app-update.yml        (更新源 https://www.deepcool.com)
```

- `7z x` 可直接解 NSIS 和 asar（asar 本质是无头的 zip）。
- `app.asar` 解开后：
  - `out/main/index.js` → 加载 `out/main/index.jsc`（**V8 字节码**）
  - `out/main/bytecode-loader.js` → 自定义 `.jsc` 加载器
  - `out/renderer/` → Vue 3 编译产物（**普通 JS**，可读，非字节码）
  - `node_modules/` → 250 个依赖

## 2. 主进程是 V8 字节码

- `out/main/index.jsc` 2.8 MB，`v8.compileCache` 风格头。
- 字节码绑定特定 Electron/V8 版本：**Electron 23 (Node 18.12 / V8 11.x)**。
- `bytecode-loader.js` 用 `vm.Script(dummyCode, {cachedData})` 执行。
- 可用 `ELECTRON_RUN_AS_NODE=1 ./electron /tmp/run_jsc.js` 直接执行字节码；
  用 `--print-bytecode --no-lazy --no-flush-bytecode` 可反汇编出
  `/tmp/jsc_bytecode.txt`（16 MB / 4033 个函数），但函数名与常量不直观，
  对定位关键逻辑帮助有限。字符串表（`/tmp/jsc_strings.txt`）更实用。

## 3. Windows 专用原生模块（无法在 Linux 加载）

`app.asar.unpacked/resources/` 下的控制器模块全部是 **PE32 DLL**（Rust napi-rs）：

| 模块 | 作用（推断） |
| --- | --- |
| `C122/index.node` | LCD 屏控制器 (C122) |
| `L122/index.node`, `index_back.node` | 风扇/泵控制器 (L122) |
| `L086`, `L136`, `L142` | 其他控制器 |
| `CH690/CH690.node` | 机箱/控制盒 |
| `system/system_info_x64.node` | 系统信息（磁盘等），Windows 返回 JSON 字符串 |
| `opencv/deep_cv_*.node`, `pixel.node` | 图像/像素处理（LCD 内容） |
| `ffmpeg/ffmplayer.node` | 视频播放（LCD 动图） |
| `event/ready.node` | 就绪事件 |
| `capture/wincapture-node.node` | 屏幕捕获 |

依赖链中还有：
- `electron-edge-js`：Windows 下桥接 .NET（HWiNFO 传感器桥），Linux 无此能力
- `node-canvas-skia`：Skia 渲染（LCD 内容），仅有 win/mac 二进制
- `@swc/core-win32-x64-msvc`：Windows 专用（应用内构建用，运行期不涉及）

USB 方面：控制器模块基于 **rusb**（libusb 的 Rust 绑定），设备
VID/PID = **`3633:0026`**（`3633` = "DC" = DeepCool，LM-Series）。
`usb`、`node-hid`、`zeromq` 等 npm 依赖都带 **Linux prebuild**，因此
Linux 环境本身具备访问 USB / HID / 消息队列的能力，缺的只是 DeepCool
私有控制器模块的 Linux 实现。

## 4. Linux 启动方案（已实现）

### 4.1 桩替换（patches/）

核心思路：不让 Windows 原生模块真加载，而是用 **Proxy 桩** 顶替。

1. **`bytecode-loader.js` 打补丁**：
   `Module._extensions['.node']` 先检查同目录 `X.stub.js`，存在则加载桩，
   否则走原 loader。这样无需逐个改 require 调用点。

2. **通用 magic 桩**（`controller_stub.js`）：
   一个 Proxy：任意属性访问返回可调用值；调用 / `new` 返回自身；
   可迭代（空）；**thenable**（await 不炸）。放到所有 Windows `.node` 旁。

3. **system_info_x64.stub.js**（特制）：
   - `getDiskFreeInfo()` / `getDiskInfo()` 返回 **JSON 字符串**（真实 DLL 也返回字符串）
   - 从 `/proc/mounts` + `df -Pk` 读取真实 Linux 磁盘容量（字节），
     主进程 `JSON.parse` 后按 `ceil(bytes/1073741824)` 转 GB
     → UI 的存储面板显示真实容量（实测：`92 / 238 GB, 39%`）

4. **node-canvas-skia/dist/binding.js**（手工 Linux stub）：
   空 SkiaCanvas/Context；关键：`module.exports = binding` 且
   `binding.default = binding`（否则 `utils.js` 的 `binding_1.default` 为 undefined）。

5. **electron-edge-js/lib/edge.js**：Linux stub（调用即 rejected Promise）。

### 4.2 沙箱绕过（容器环境）

受限容器里 Chromium 的 seccomp 会使 `shutdown()` 返回 EPERM 导致启动崩溃。
- `patches/shutdown_epm_shim.c`：`LD_PRELOAD` 拦截 `shutdown()`，EPERM 时假装成功。
- 编译：`gcc -shared -fPIC -O2 -o /tmp/shutdown_epm_shim.so patches/shutdown_epm_shim.c -ldl`
- 本环境还需用 `gdb` 启动绕过 ptrace/seccomp 限制：
  ```
  gdb -q -batch -ex "set env LD_PRELOAD=/tmp/shutdown_epm_shim.so" \
      -ex "set env DISPLAY=:0" -ex run \
      --args ./electron --no-sandbox --disable-gpu --remote-debugging-port=9224 \
             app/resources/app.asar.extracted
  ```

### 4.3 验证结果（原生 Electron 23.3.13, XWayland）

- main 窗口 `index.html#/` 完整渲染仪表盘：CPU / GPU / 内存 / 网络 / 存储
- 运行期无 JS 错误（`window.__errors__` 为空数组）
- 日志仅剩无害的 `app/check-sw-fw-update timeout`（无网络）、`zeromq init`、
  `test init \\.\pipe\deepcool_sensor_data`、`ready init error: null`
- 磁盘面板显示真实容量（Linux `df` 数据）

Wine 路径：`wine ./DeepCool.exe --no-sandbox --remote-debugging-port=9222`
也能启动完整 UI，但传感器全 0（Windows 传感器桥不可用）。

## 5. 仍未解决 / 后续工作

| 项目 | 状态 | 建议 |
| --- | --- | --- |
| UI 启动 | ✅ | 桩替换 |
| 磁盘信息 | ✅ | `df` 真实数据 |
| 设备枚举 | ❌ | 需要控制器模块 Linux 实现 + 真机 |
| 传感器（温度/风扇） | ❌ | 抓 Windows USB 通信，用 libusb/`usb` 包重写 |
| LCD 屏内容 | ❌ | 需 skia/像素格式逆向 + 控制器协议 |
| RGB/风扇控制 | ❌ | 同上 |

关键路径：**抓 USB 协议 → 用 `usb`(npm)/libusb 实现控制器模块 → 替换
`resources/*/*.node` 桩**。抓包可用 Wireshark+usbpcap（Windows 真机）或
Wine + USB passthrough + `usbmon`（Linux）。

## 6. 有用的调试工具（本仓库 scripts/ 之外）

- CDP 远程调试：`http://127.0.0.1:9224/json` → `Runtime.evaluate`
- 截屏（renderer 内 DOM→SVG→canvas）：见 /tmp/domshot.py
- 字节码字符串表：`strings -el` 或自定义扫描（/tmp/jsc_strings.txt）
