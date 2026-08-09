# DeepCool 1.2.12 Linux 移植状态

日期：2026-08-09

## 结论

官方 Electron UI 和 V8 字节码主进程已经在 Arch Linux 原生 Electron 23.3.13
上启动。当前 LM-Series (`3633:0026`) 能被官方主进程枚举，Linux bridge 将
`deepcool-lm-daemon` 的真实传感器映射成官方 renderer 所需的数据结构。

## 已接通

- `app/get-sensors-data` → Linux daemon snapshot
- `app/get-systeminfo` → `/proc`、DMI、`nvidia-smi`
- `app/get-disk-list` → `df`
- `app/get-device-list` → 官方枚举，失败时 sysfs fallback
- `l122/image-transmission` → Linux 动态 320×240 SVG 预览
- `linux/capture-preview` → Electron `capturePage` → PNG → daemon `image`
- `linux/daemon-command` → `monitor` / `zen` / `brightness`

## 尚未移植

官方 L122 Rust/N-API Windows DLL 的完整函数实现：`sendImageData`、
`sendGeneralCommand`、`changeMode`、`startFileDownload`、`changeSettings`、
`reboot` 等。当前不允许通过官方 UI 刷固件；实际帧写入由 Linux Rust daemon 完成。

## 启动优化（2026-08-09）

- 直接使用 Electron dist ELF，不再依赖 node PATH。
- 跳过重复 prepare。
- 单实例锁 + second-instance 聚焦已有窗口。
- 桌面入口 StartupNotify。

## 初始加载页卡死修复（2026-08-09）

- 原因：主进程等待 Windows 原生 `ready.node` 完成握手后才会从 `launch.html` 切换到 `index.html`，Linux 桩无法触发握手。
- 修复：`linux-compat.js` 在 `app.whenReady()` 后发送 `worker/ready`、关闭 `launch.html`、显示并聚焦主窗口。
- 验证：CDP 中 `launch.html` 目标已消失，仅剩 `index.html` 窗口（可见、聚焦）。

## 官方预设屏幕个性化（2026-08-09）

- 官方 L122 个性化设置（推荐组合/主副数据/方向）已桥接到 LCD：
  保存后由 renderer 生成 320×240 画面，每 3s 推送到 daemon（image 命令）。
- 支持 CPU监控 / GPU监控 / 功耗监控组合及 0/90/180/270 旋转。
- 亮度绝对值不支持（daemon 仅有 up/down 步进）；禅状态映射为待机。
- 环境注意：deepcool-lm-rust 包已被卸载，运行中的 daemon 是残留进程；
  已构建新包 `packaging/deepcool-lm-rust/deepcool-lm-rust-1.1.0-1-x86_64.pkg.tar.zst`
  并提供 `scripts/reinstall-daemon.sh`（需 sudo）恢复服务。

## 渲染所有权（2026-08-09）

- 原生 Slint：deepcool-lm-daemon 内嵌软件渲染器（monitor/auto）。
- 当前项目：linux-overlay.js Canvas 生成预设画面 → linux/push-image → daemon static。
- 已通过 scripts/disable-native-render.sh 将 daemon 配置为 renderer=rust + 黑色空页，
  LCD 不再显示原生监控画面；官方预设激活时 LCD 仅显示当前项目推送内容。
- 新 daemon（21:27 构建，21:29 安装）在 static 模式也会采样，传感器保持实时。

## 软件内切换方式（2026-08-09 修订）

- 监控：当前项目（linux-overlay.js Canvas）生成监控画面，每 3s 推屏；daemon 保持 static。
- 推送预览：进入 LM-Series 页面后，截图预览区域并每 3s 推屏。
- 待机：daemon 进入 off 并保持（hold 状态防止状态轮询切回）。
- 官方预设保存：按 digitalData 组合生成画面并每 3s 推屏。
- 原生 Slint 渲染器：二进制内仍编译有该代码，但 lcd.json 已是 renderer=rust + 黑色空页，
  不再调用；LCD 内容全部来自当前项目推帧。

## 统一渲染（2026-08-09）

- 移除 main 进程 monitorPreview SVG 渲染（l122/image-transmission 改为静态占位）。
- linux-overlay.js 维护 lastFrameDataUrl，软件预览直接复用该图。
- LCD 与软件预览同一渲染源、内容一致；默认启动即进入当前项目监控推帧。
- image-transmission 返回裸 data URL 字符串（官方页面直接绑 img.src）。

## 图片上传修复（2026-08-09）

- 官方 selectImg/uploadSelectedMedia 依赖 Windows DLL → Linux 桩卡“处理中”。
- 已用 Electron dialog + nativeImage 实现：选择图片 → 裁剪缩放 320×240 →
  frameDataUrl → overlay image 模式推屏；getAllMedia 维护内存列表。
- 视频上传明确返回不支持错误，不再卡死。

## 调整显示数据（2026-08-09）

- 真实 UI 点击推荐组合/下拉均验证生效：config 更新、帧内容变化、LCD 同步。
- 修复官方“内存负载”选项未映射问题（现显示内存百分比）。
- 支持字段：CPU 温度/功耗/负载/频率、时间、GPU 温度/功耗、内存负载。

## 精简交互（2026-08-09 最终版）

- 移除：Linux 控制台按钮与 `linux/open-web-console` IPC、监控按钮与监控推帧、
  `linux/daemon-command` 的 monitor 白名单。
- 推送预览集成到软件：进入 LM-Series 页面自动截图预览区并每 3 秒推屏；
  离开页面自动停止；预设/图片激活时让位。
- 待机：右下角唯一按钮；待机后自动预览不再打扰（zenActive 锁），
  保存预设/上传图片后恢复。
- 修复：capturePage 并发挂起（预览启动锁 + 4s 超时）、自动预览守卫条件写反、
  trace 清理时误删调用、待机被自动预览覆盖。

## CPU 频率单位修复（2026-08-09）

- daemon snapshot.cpu_freq 单位为 GHz（如 5.55），渲染层此前直接按 MHz 显示，
  导致 LCD 出现“6 MHz”等错误值。
- 已修复：overlay fieldValue 对 cpu frequency 乘以 1000 再取整（MHz）。
- 验证：raw 5.554431 GHz → 显示 5554 MHz，与软件仪表盘一致。

## 亮度控制修复（2026-08-10）

- 官方“亮度控制”本质是软件遮罩：`.mask` 的 opacity = 1 - (brightness + 70) / 170，
  brightness=0 最暗、=100 最亮；daemon 的 up/down 是硬件步进，与滑块语义不同。
- 已实现：overlay 捕获 `brightnessControl`，在推屏前对画布叠加同公式黑色遮罩，
  LCD 与软件预览亮度一致。
- 验证：brightness=100 → 帧平均亮度 18；brightness=0 → 8（与公式一致）。

## 主数据温度越界优化（2026-08-10）

- 原因：主数据 70px 字体下，带小数的温度（如 48.6）或 3 位温度（105.6）会超出
  官方背景区域（主区右边界约 x=179）。
- 修复：
  1. 主数据温度取整显示（48.6 → 49，105.6 → 106）；
  2. 自适应缩放：数值+单位组合宽度超过 maxMainWidth 时逐级缩小字号（最小 28px）。
- 实测：106 在 70px 下宽 107px，+单位 16px 后 123px < 140px 限制；4 位数字在 54px
  下 114px 也安全。

## 频率显示格式（2026-08-10）

- CPU Frequency 改为 GHz 保留 1 位小数（与官方一致，如 5.5 GHZ），不再显示
  MHz 整数（5554 MHz），避免主/副数据过长越界。
- 验证：raw 2.8984852 GHz → 显示 2.9 GHZ。

## 主数据边界内居中（2026-08-10）

- 主数据数值+单位整体在主区域 [valueX, blockX] 内水平居中（横屏中心 104px）。
- 仍保留自适应缩放（不越界）+ 温度取整。
- 实测：主数据白色像素范围 x=54~155，中心 105px ≈ 区域中心 104px。

## 主数据下方文字描述居中（2026-08-10）

- "CPU TEMP"/"GPU TEMP" 等标签与图标一起在主区域内水平居中（不再贴左）。
- 实测：标签+图标范围 x=80~127，中心 104px = 主区域中心 104px。
- 注：亮度遮罩会整体调暗文字，属正常亮度效果。

## 开机自启 + 后台运行（2026-08-10）

- 新增 scripts/install-autostart.sh：安装 XDG autostart（登录后 --hidden 启动）。
- run.sh 支持 --hidden/--background/DEEPCOOL_BACKGROUND=1。
- linux-compat.js 后台模式：隐藏窗口 + 系统托盘（点击切换、菜单显示/退出），
  并对所有窗口 setBackgroundThrottling(false) 保证后台推帧不被节流。
- 验证：后台启动窗口 visible=false、推帧日志持续、二次启动显示窗口且单实例。

## 关闭窗口后台化（2026-08-10）

- 窗口 close 事件拦截：非退出时 preventDefault + hide()，进程与 LCD 推帧保持。
- 托盘常驻：无论前台/后台启动均创建托盘；左键切换、菜单“显示主界面/退出”。
- 适配 Niri Super+Q（窗口管理器关闭）→ 隐藏后台而非退出。
- 托盘“退出”设置 isQuitting=true 后 app.quit()；before-quit 放行系统注销。
- 验证：window.close() 后 visible=false、进程存活、推帧持续；二次启动恢复显示、单实例。

## 重启恢复 LCD 预设（2026-08-10）

- 新增 linux/preset-save、linux/preset-load IPC（userData/preset.json）。
- overlay 保存 modelConfigurationSet 时持久化；启动 1.8s 后自动 restorePreset。
- 验证：设置 GPU监控（亮度60）→ 重启 → active=true/mode=preset/brightness=60、
  daemon static、推帧持续。
