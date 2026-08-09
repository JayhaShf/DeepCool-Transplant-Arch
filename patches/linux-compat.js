'use strict';

// Linux compatibility layer for the bytecode-only DeepCool 1.2.12 main process.
// It is loaded before out/main/index.jsc and intercepts selected IPC handlers.
// The official renderer and most of the official main process remain unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } = require('electron');

// 1×1 黑色 PNG（统一渲染后 main 进程不再生成任何画面）
const BLACK_320_240_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// The official main process waits for the Windows-only ready.node module
// before switching from launch.html (loading splash) to index.html. With the
// Linux stub this handshake never completes, so force the transition once the
// app is ready. This also guarantees the main window is visible and focused.
const IS_BACKGROUND = process.env.DEEPCOOL_BACKGROUND === '1';
let tray = null;
let isQuitting = false; // 仅托盘“退出”或系统关机时真正退出；关闭窗口只隐藏到后台

app.whenReady().then(() => {
  // 后台运行：禁用渲染节流，保证 setInterval 推帧不因窗口不可见被暂停。
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
    }
  } catch (_) {}

  setTimeout(() => {
    try {
      const windows = BrowserWindow.getAllWindows();
      const launch = windows.find((win) => win.getURL().includes('launch.html'));
      const main = windows.find((win) => win.getURL().includes('index.html'));
      for (const win of windows) {
        try { win.webContents.send('worker/ready'); } catch (_) {}
        try { win.webContents.setBackgroundThrottling(false); } catch (_) {}
      }
      if (launch && launch !== main) {
        try { launch.close(); } catch (_) {}
      }
      const target = main || windows[0];
      // 关闭窗口 = 隐藏到后台（适配 Niri Super+Q / 窗口管理器关闭），托盘常驻。
      // 只有托盘“退出”或 app.quit()（isQuitting=true）才真正关闭。
      for (const win of windows) {
        if (win === launch) continue; // launch 页照常关闭
        win.on('close', (event) => {
          if (!isQuitting) {
            event.preventDefault();
            try { win.hide(); } catch (_) {}
          }
        });
      }
      if (target) {
        try { setupTray(target); } catch (error) { log('tray setup failed:', error); }
        if (IS_BACKGROUND) {
          // 后台模式：隐藏窗口
          try { target.hide(); } catch (_) {}
        } else {
          if (target.isMinimized()) target.restore();
          target.show();
          target.focus();
        }
      }
    } catch (error) {
      try { console.error('[DeepCool Linux] launch transition fallback failed:', error); } catch (_) {}
    }
  }, 1200);
});

// 所有窗口关闭（理论上被上面拦截后不会发生）也不退出，保持后台/托盘。
app.on('window-all-closed', () => {
  // 保持运行（后台渲染 LCD 需要）
});

function setupTray(targetWindow) {
  if (tray) return;
  let icon;
  try {
    icon = nativeImage.createFromPath(
      path.join(__dirname, '..', '..', 'resources', 'icon.png')
    );
  } catch (_) {}
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
  }
  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip('DeepCool (Linux Port)');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => {
        try {
          if (targetWindow.isMinimized()) targetWindow.restore();
          targetWindow.show();
          targetWindow.focus();
        } catch (_) {}
      } },
    { label: '退出', click: () => {
        isQuitting = true;
        try { app.quit(); } catch (_) {}
      } },
  ]));
  tray.on('click', () => {
    try {
      if (targetWindow.isVisible()) targetWindow.hide();
      else { targetWindow.show(); targetWindow.focus(); }
    } catch (_) {}
  });
}

// Desktop launcher double-click / repeated launches: keep a single instance.
// A second instance would otherwise block on the Chromium profile lock while
// the first window is already open, which looks like a very slow startup.
app.on('before-quit', () => { isQuitting = true; });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (_) {}
  });
}

const SOCKET_CANDIDATES = [
  '/run/deepcool-lm/deepcool-lm.sock',
  process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, 'deepcool-lm.sock'),
].filter(Boolean);
const LOG_DIR = path.join(os.homedir(), '.cache', 'deepcool-official-linux');
const LOG_FILE = path.join(LOG_DIR, 'compat.log');
const serialFallback = process.env.DEEPCOOL_SERIAL || 'LM-Series';

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
function log(...args) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(formatLog).join(' ')}\n`);
  } catch (_) {}
}
function formatLog(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}
function ok(data) { return { code: 0, message: 'successful', data }; }
function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { return fallback; }
}
function execText(file, args = []) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 2500 }).trim(); } catch (_) { return ''; }
}
function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}
function svgDataUrl(svg) { return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`; }

function daemonSocket() {
  return SOCKET_CANDIDATES.find((candidate) => {
    try { return fs.statSync(candidate).isSocket(); } catch (_) { return false; }
  });
}

function daemonRequest(request, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socketPath = daemonSocket();
    if (!socketPath) return reject(new Error('deepcool-lm daemon socket not found'));
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (_) {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('deepcool-lm daemon timeout')), timeoutMs);
    socket.on('connect', () => {
      const body = JSON.stringify(request);
      if (Buffer.byteLength(body) > 20 * 1024 * 1024) {
        finish(reject, new Error('deepcool-lm request is too large'));
        return;
      }
      socket.end(body);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        finish(resolve, JSON.parse(body));
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.on('error', (error) => finish(reject, error));
  });
}

// ---- 上传媒体（Linux 实现）----
// 官方上传链路依赖 Windows DLL（文件对话框/opencv/L122 控制器），Linux 桩无法完成，
// 这里用 Electron 原生能力实现：选择图片 → 裁剪/缩放 320×240 → 返回 frameDataUrl，
// 由 renderer overlay 负责推屏（保持渲染职责唯一）。
const mediaStore = { imageList: [], gifList: [], videoList: [] };
let mediaId = 1;

function mediaFromUpload(data, serialNumber) {
  const type = String(data?.mediaType || 'image').toLowerCase();
  const pathValue = data?.path || data?.originalPath || '';
  const id = String(data?.id || `linux-${mediaId++}`);
  const isGif = type === 'gif' || /\.gif$/i.test(pathValue);
  const bucket = isGif ? 'gifList' : (type === 'video' ? 'videoList' : 'imageList');
  const item = {
    id,
    mediaType: isGif ? 'gif' : 'image',
    elementPath: pathValue,
    firstFramePath: pathValue,
    name: pathValue.split('/').pop() || 'image',
    isCurrent: true,
    serialNumber,
  };
  // 同一时间只保留一个 isCurrent
  for (const list of [mediaStore.imageList, mediaStore.gifList, mediaStore.videoList]) {
    for (const entry of list) entry.isCurrent = false;
  }
  mediaStore[bucket].push(item);
  return { item, bucket };
}

function processImageToFrame(data) {
  const pathValue = data?.path || data?.originalPath || '';
  if (!pathValue) throw new Error('上传数据缺少文件路径');
  const image = nativeImage.createFromPath(pathValue);
  if (image.isEmpty()) throw new Error(`无法读取图片: ${pathValue}`);
  let img = image;
  // 官方裁剪参数：positionX/Y + cutWidth/cutHeight（可缺省）
  const cx = Number(data?.positionX);
  const cy = Number(data?.positionY);
  const cw = Number(data?.cutWidth);
  const ch = Number(data?.cutHeight);
  if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0) {
    const crop = { x: Math.round(cx), y: Math.round(cy), width: Math.round(cw), height: Math.round(ch) };
    try { img = image.crop(crop); } catch (_) {}
  }
  const resized = img.resize({ width: 320, height: 240, quality: 'best' });
  if (resized.isEmpty()) throw new Error('图片处理失败');
  return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
}

let statusCache = null;
let statusAt = 0;
let statusPending = null;
let externalHoldActive = false;

async function daemonStatus() {
  const now = Date.now();
  if (statusCache && now - statusAt < 700) return statusCache;
  if (statusPending) return statusPending;
  // 传感器采样：新 daemon 默认 auto 模式不采样，需要短暂处于 monitor 模式
  // 才会更新快照（monitor 模式渲染的是黑色空页，不产生任何可见内容）。
  // 注意：外部推帧（预设/图片/预览）激活时不能切 monitor，否则会覆盖画面。
  if (!externalHoldActive) {
    await daemonRequest({ action: 'monitor' }).catch((error) => {
      log('ensure monitor failed:', error);
    });
  }
  statusPending = daemonRequest({ action: 'status' })
    .then((status) => {
      statusCache = status;
      statusAt = Date.now();
      return status;
    })
    .catch((error) => {
      log('daemon status failed:', error);
      return fallbackStatus(error);
    })
    .finally(() => { statusPending = null; });
  return statusPending;
}

function fallbackStatus(error) {
  const mem = readText('/proc/meminfo');
  const values = Object.fromEntries(mem.split('\n').map((line) => {
    const m = line.match(/^([^:]+):\s+(\d+)/);
    return m ? [m[1], Number(m[2]) * 1024] : [line, 0];
  }));
  const total = values.MemTotal || os.totalmem();
  const available = values.MemAvailable || os.freemem();
  const used = Math.max(0, total - available);
  return {
    ok: false,
    mode: 'unknown',
    error: error ? String(error.message || error) : 'daemon unavailable',
    snapshot: {
      cpu_temp: 0,
      cpu_usage: 0,
      cpu_power: 0,
      cpu_freq: 0,
      gpu_temp: 0,
      gpu_usage: 0,
      gpu_power: 0,
      gpu_freq: 0,
      gpu_mem_used: 0,
      gpu_mem_total: 0,
      mem_used: used,
      mem_total: total,
      mem_percent: total ? used / total * 100 : 0,
      disks: [],
      nets: [],
      fans: [],
      local_time: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
    },
  };
}

function mapSensors(status) {
  const s = status && status.snapshot ? status.snapshot : fallbackStatus().snapshot;
  const netRows = Array.isArray(s.nets) ? s.nets : [];
  const diskRows = Array.isArray(s.disks) ? s.disks : [];
  // Prefer physical interfaces; TUN/bridge/veth counters overlap with the
  // underlying NIC and would otherwise be double-counted.
  const physicalNets = netRows.filter((row) => !/^(Meta|lo|docker|bridge|veth|virbr|br-)/i.test(String(row.name || '')));
  const countedNets = physicalNets.length ? physicalNets : netRows;
  const rx = countedNets.reduce((sum, row) => sum + (Number(row.rx_bytes_s) || 0), 0);
  const tx = countedNets.reduce((sum, row) => sum + (Number(row.tx_bytes_s) || 0), 0);
  const read = diskRows.reduce((sum, row) => sum + (Number(row.read_bytes_s) || 0), 0);
  const write = diskRows.reduce((sum, row) => sum + (Number(row.write_bytes_s) || 0), 0);
  const totalMem = Number(s.mem_total) || os.totalmem();
  const usedMem = Number(s.mem_used) || Math.max(0, totalMem - os.freemem());
  const gpuMemTotal = Number(s.gpu_mem_total) || 0;
  const gpuMemUsed = Number(s.gpu_mem_used) || 0;
  const now = new Date();
  return {
    cpu: {
      name: cpuName(),
      name2: '',
      temperature: round(s.cpu_temp),
      usage: round(s.cpu_usage),
      power: round(s.cpu_power),
      clock: round((Number(s.cpu_freq) || 0) * ((Number(s.cpu_freq) || 0) < 100 ? 1000 : 1), 0),
    },
    gpu: {
      name: gpuName(),
      name2: '',
      clock: round(s.gpu_freq, 0),
      temperature: round(s.gpu_temp),
      power: round(s.gpu_power),
      usage: round(s.gpu_usage),
      memSize: round(gpuMemTotal / 1073741824),
      memUsage: round(gpuMemUsed / 1073741824),
      memoryClock: 0,
    },
    network: { upload: round(tx / 1024), download: round(rx / 1024) },
    disk: { read: round(read / 1048576), write: round(write / 1048576), temperature: round(s.ssd_temp) },
    memory: {
      size: round(totalMem / 1073741824),
      usage: round(usedMem / 1073741824),
      used: round(usedMem / 1073741824),
      clock: memoryClock(),
      usedRate: round(s.mem_percent ?? (totalMem ? usedMem / totalMem * 100 : 0)),
    },
    mainboard: {
      v3: 0,
      v5: 0,
      v12: 0,
      fan: Object.fromEntries((Array.isArray(s.fans) ? s.fans : []).map((fan, index) => [fan.name || `fan${index}`, fan.rpm || 0])),
    },
    time: {
      value: s.local_time || now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      amOrPm: now.getHours() >= 12 ? 'PM' : 'AM',
    },
    connectivity: { ethernet: 'connected', wifi: 'unknown', bluetooth: 'unknown' },
  };
}

let cachedCpuName;
function cpuName() {
  if (cachedCpuName !== undefined) return cachedCpuName;
  const line = readText('/proc/cpuinfo').split('\n').find((row) => row.startsWith('model name')) || '';
  cachedCpuName = line.split(':').slice(1).join(':').trim() || os.cpus()[0]?.model || 'CPU';
  return cachedCpuName;
}
let cachedGpuName;
function gpuName() {
  if (cachedGpuName !== undefined) return cachedGpuName;
  cachedGpuName = execText('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).split('\n')[0] || 'GPU';
  return cachedGpuName;
}
let cachedMemoryClock;
function memoryClock() {
  if (cachedMemoryClock !== undefined) return cachedMemoryClock;
  const out = execText('dmidecode', ['--type', 'memory']);
  const speeds = [...out.matchAll(/^\s*Configured Memory Speed:\s*(\d+)\s*MT\/s/gm)].map((m) => Number(m[1]));
  cachedMemoryClock = speeds.length ? Math.max(...speeds) : 0;
  return cachedMemoryClock;
}

function systemInfo() {
  const board = [readText('/sys/devices/virtual/dmi/id/board_vendor'), readText('/sys/devices/virtual/dmi/id/board_name')].filter(Boolean).join(' ');
  const nvidia = execText('nvidia-smi', ['--query-gpu=name,pci.bus_id', '--format=csv,noheader,nounits']).split('\n').filter(Boolean);
  const gpu = nvidia.map((line, index) => {
    const comma = line.lastIndexOf(',');
    return {
      name: (comma >= 0 ? line.slice(0, comma) : line).trim(),
      bus: 'PCIe 4.0 x16',
      busId: comma >= 0 ? line.slice(comma + 1).trim() : '',
      default: index === 0,
    };
  });
  return {
    deviceName: os.hostname(),
    systemName: `${readText('/etc/os-release').match(/^PRETTY_NAME=(.*)$/m)?.[1]?.replace(/^"|"$/g, '') || 'Arch Linux'} ${os.release()}`,
    cpuName: cpuName(),
    gpu: gpu.length ? gpu : [{ name: gpuName(), bus: 'PCIe 4.0 x16', default: true }],
    mainboardName: board || 'Mainboard',
    motherboardChipset: '',
    ramName: [`${round(os.totalmem() / 1073741824, 0)} GB RAM`],
    ramSlotCount: 1,
    ramSlotIndex: [0],
    diskName: listDisks().map((d) => d.name),
    diskSingle: listDisks(),
  };
}

function listDisks() {
  const rows = [];
  const seen = new Set();
  const text = execText('df', ['-B1', '--output=source,size,used,avail,pcent,target', '-x', 'tmpfs', '-x', 'devtmpfs']);
  for (const line of text.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m || !m[1].startsWith('/dev/') || m[1].startsWith('/dev/loop') || seen.has(m[1])) continue;
    seen.add(m[1]);
    // The official main process converts native byte values to whole GiB
    // before returning them to the renderer. Because this handler replaces
    // the official one, return GiB here as the renderer expects.
    const size = Math.ceil(Number(m[2]) / 1073741824);
    const used = Math.ceil(Number(m[3]) / 1073741824);
    const free = Math.max(0, size - used);
    rows.push({
      name: m[1].replace('/dev/', ''),
      diskName: m[1].replace('/dev/', ''),
      size,
      used,
      free,
      freeSize: free,
      usedRate: Number(m[5]),
      mountPoint: m[6],
      index: rows.length,
      diskIndex: rows.length,
    });
  }
  return rows;
}

function usbLmDevice() {
  const base = '/sys/bus/usb/devices';
  try {
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (readText(path.join(dir, 'idVendor')).toLowerCase() !== '3633') continue;
      if (readText(path.join(dir, 'idProduct')).toLowerCase() !== '0026') continue;
      return {
        serial: readText(path.join(dir, 'serial'), serialFallback),
        product: readText(path.join(dir, 'product'), 'LM-Series'),
        manufacturer: readText(path.join(dir, 'manufacturer'), 'DC'),
        version: readText(path.join(dir, 'bcdDevice'), '0009'),
      };
    }
  } catch (_) {}
  return null;
}

const deviceImage = svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="452" height="280" viewBox="0 0 452 280">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#020617"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="9" stdDeviation="10" flood-opacity=".45"/></filter></defs>
<rect width="452" height="280" rx="26" fill="url(#g)"/>
<g filter="url(#s)"><rect x="119" y="28" width="214" height="154" rx="28" fill="#0b1220" stroke="#35e0ff" stroke-width="4"/><rect x="136" y="45" width="180" height="120" rx="16" fill="#050a12"/><text x="226" y="101" text-anchor="middle" fill="#35e0ff" font-family="sans-serif" font-size="26" font-weight="700">LM-SERIES</text><text x="226" y="134" text-anchor="middle" fill="#dbe7f5" font-family="sans-serif" font-size="16">320 × 240 LCD</text></g>
<path d="M165 184 C145 214,113 219,74 238 M287 184 C307 214,339 219,378 238" fill="none" stroke="#334155" stroke-width="14" stroke-linecap="round"/>
<circle cx="65" cy="242" r="23" fill="#0f172a" stroke="#a78bfa" stroke-width="4"/><circle cx="387" cy="242" r="23" fill="#0f172a" stroke="#35e0ff" stroke-width="4"/>
</svg>`);

function fallbackDeviceList() {
  const device = usbLmDevice();
  if (!device) return [];
  return [{
    version: device.version === '0009' ? '9.9' : device.version,
    manufacturerName: device.manufacturer,
    serialNumber: device.serial,
    productName: 'LM-Series',
    productId: 38,
    vendorId: 13875,
    data: {
      serialNumber: device.serial,
      mode: { value: 1 },
      options: {
        noLoadScreen: 1,
        gyroStatus: 1,
        screenStatus: 1,
        screenRotate: 0,
        screenBrightness: 30,
        rgbOptical: 0,
        cpuFanIOInterface: '',
        pumpFanIOInterface: '',
        temperatureDisplay: 0,
      },
      situationalMode: { mainAreaMode: 0, auxiliaryAreaMode: 0, styleType: 0, spectrumType: 0 },
      motionMode: { duration: 0, animation: 0, picRgbStatus: 0, gifRgbStatus: 0 },
      motionModeScreen: { type: 0, index: 0 },
      recorderMode: { cpuClock: 1, cpuTemperature: 1 },
    },
    subheadingName: 'LCD Liquid Cooler · Linux',
    devicesImg: deviceImage,
  }];
}


let lastL122Config = {
  brightnessControl: 30,
  zenMode: false,
  mandatoryZenMode: false,
  modeChange: 0,
  digitalData: { mainData: 'CPU Temperature', subData1: 'CPU Frequency', subData2: 'CPU Power', orientation: 0 },
};

const originalHandle = ipcMain.handle.bind(ipcMain);
const overrides = {
  'app/get-sensors-data': {
    mode: 'replace',
    fn: async () => ok(mapSensors(await daemonStatus())),
  },
  'app/get-systeminfo': {
    mode: 'replace',
    fn: async () => ok(systemInfo()),
  },
  'app/get-disk-list': {
    mode: 'replace',
    fn: async () => ok(listDisks()),
  },
  'app/get-device-list': {
    mode: 'wrap',
    fn: async (original, event, ...args) => {
      try {
        let response = await original(event, ...args);
        if (response?.data?.length) return response;
        await new Promise((resolve) => setTimeout(resolve, 250));
        response = await original(event, ...args);
        if (response?.data?.length) return response;
      } catch (error) {
        log('official device list failed:', error);
      }
      return ok(fallbackDeviceList());
    },
  },
  'app/check-sw-fw-update': {
    mode: 'replace',
    fn: async () => ok({ visible: false, updateInfo: null, fwUpdateInfo: [] }),
  },
  'app/check-fw-update': {
    mode: 'replace',
    fn: async () => ok({ visible: false, updateInfo: null, fwUpdateInfo: [] }),
  },
  'l122/modelConfigurationSearch': {
    mode: 'wrap',
    fn: async (original, event, ...args) => {
      try {
        const response = await original(event, ...args);
        if (response?.data) lastL122Config = response.data;
        return response;
      } catch (error) {
        log('L122 config read failed:', error);
        return ok(lastL122Config);
      }
    },
  },
  'l122/modelConfigurationSet': {
    mode: 'wrap',
    fn: async (original, event, config, ...args) => {
      lastL122Config = config || lastL122Config;
      let response;
      try { response = await original(event, config, ...args); }
      catch (error) { log('L122 config write failed:', error); response = ok(lastL122Config); }
      // 官方设置保存成功后，renderer 侧的 linux-overlay.js 会捕获该调用并
      // 按 digitalData 组合生成 320×240 画面持续推送到 LCD（无需 root）。
      return response;
    },
  },
  // 统一渲染：画面只由 renderer 侧 linux-overlay.js 生成并推屏；
  // 这里只返回静态占位（黑色 PNG data URL 字符串，页面直接绑 img.src）。
  'l122/image-transmission': {
    mode: 'replace',
    fn: async () => BLACK_320_240_PNG,
  },
  'media/selectImg': {
    mode: 'replace',
    fn: async (event) => {
      const win = event.sender.getOwnerBrowserWindow ? event.sender.getOwnerBrowserWindow() : BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win || undefined, {
        title: '选择图片',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }],
      });
      if (result.canceled || !result.filePaths.length) return ok({ filePaths: [] });
      return ok({ filePaths: result.filePaths });
    },
  },
  'media/selectGif': {
    mode: 'replace',
    fn: async (event) => {
      const win = event.sender.getOwnerBrowserWindow ? event.sender.getOwnerBrowserWindow() : BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win || undefined, {
        title: '选择 GIF',
        properties: ['openFile'],
        filters: [{ name: 'GIF', extensions: ['gif'] }],
      });
      if (result.canceled || !result.filePaths.length) return ok({ filePaths: [] });
      return ok({ filePaths: result.filePaths });
    },
  },
  'media/selectVideo': {
    mode: 'replace',
    fn: async (event) => {
      const win = event.sender.getOwnerBrowserWindow ? event.sender.getOwnerBrowserWindow() : BrowserWindow.getAllWindows()[0];
      const result = await dialog.showOpenDialog(win || undefined, {
        title: '选择视频',
        properties: ['openFile'],
        filters: [{ name: 'Videos', extensions: ['mp4', 'webm', 'avi', 'mkv'] }],
      });
      if (result.canceled || !result.filePaths.length) return ok({ filePaths: [] });
      return ok({ filePaths: result.filePaths });
    },
  },
  'l122/uploadSelectedMedia': {
    mode: 'replace',
    fn: async (_event, media, serialNumber) => {
      try {
        const frameDataUrl = processImageToFrame(media || {});
        const { item } = mediaFromUpload(media, serialNumber);
        log('upload image ok', item.elementPath, frameDataUrl.length);
        return ok({ frameDataUrl, media: item });
      } catch (error) {
        log('upload image failed:', error);
        return { code: 1, message: error.message || String(error), data: null };
      }
    },
  },
  'l122/modifyMedia': {
    mode: 'replace',
    fn: async (_event, media, id, serialNumber) => {
      try {
        const frameDataUrl = processImageToFrame(media || {});
        const { item } = mediaFromUpload(media, serialNumber);
        log('modify image ok', item.elementPath, frameDataUrl.length);
        return ok({ frameDataUrl, media: item });
      } catch (error) {
        log('modify image failed:', error);
        return { code: 1, message: error.message || String(error), data: null };
      }
    },
  },
  'l122/uploadSelectedVideo': {
    mode: 'replace',
    fn: async () => ({ code: 1, message: 'Linux 移植版暂不支持视频上传（可用图片/GIF）', data: null }),
  },
  'l122/modifyVideo': {
    mode: 'replace',
    fn: async () => ({ code: 1, message: 'Linux 移植版暂不支持视频编辑', data: null }),
  },
  'l122/getAllMedia': {
    mode: 'replace',
    fn: async () => ok(mediaStore),
  },
  'l122/deleteOneMedia': {
    mode: 'replace',
    fn: async (_event, id) => {
      for (const key of ['imageList', 'gifList', 'videoList']) {
        mediaStore[key] = mediaStore[key].filter((m) => String(m.id) !== String(id));
      }
      return ok(true);
    },
  },
  'l122/getElementDataCurrent': {
    mode: 'replace',
    fn: async () => ok([]),
  },
  'l122/setElementDataCurrent': {
    mode: 'replace',
    fn: async () => ok(true),
  },
  'sys/restart-system': {
    mode: 'replace',
    fn: async () => ok(false),
  },
};

ipcMain.handle = function linuxCompatHandle(channel, listener) {
  const override = overrides[channel];
  if (!override) return originalHandle(channel, listener);
  log('intercept IPC', channel, override.mode);
  if (override.mode === 'replace') {
    return originalHandle(channel, async (event, ...args) => {
      try { return await override.fn(event, ...args); }
      catch (error) { log('IPC replace failed', channel, error); return { code: 500, message: error.message || String(error), data: null }; }
    });
  }
  return originalHandle(channel, async (event, ...args) => {
    try { return await override.fn(listener, event, ...args); }
    catch (error) { log('IPC wrapper failed', channel, error); return { code: 500, message: error.message || String(error), data: null }; }
  });
};

originalHandle('linux/status', async () => {
  const status = await daemonStatus();
  return { ...status, socket: daemonSocket(), compatibility: 'DeepCool 1.2.12 Linux bridge' };
});
originalHandle('linux/daemon-command', async (_event, request) => {
  const payload = typeof request === 'string' ? { action: request } : { ...(request || {}) };
  // 用户可见命令仅保留 status/zen（监控切换已按要求移除）。
  const allowed = new Set(['status', 'zen']);
  if (!allowed.has(payload.action)) throw new Error(`Linux bridge 不允许命令: ${payload.action}`);
  if (payload.action === 'brightness') payload.direction = payload.direction === 'down' ? 'down' : 'up';
  delete payload.data;
  delete payload.color;
  const response = await daemonRequest(payload);
  statusCache = response;
  statusAt = Date.now();
  return response;
});
originalHandle('linux/windows', async () => {
  return BrowserWindow.getAllWindows().map((win) => ({
    url: win.getURL(),
    title: win.getTitle(),
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    bounds: win.getBounds(),
  }));
});
// 个性化设置持久化：重启软件后自动恢复 LCD 显示内容
function presetStorePath() {
  try { return path.join(app.getPath('userData'), 'preset.json'); } catch (_) { return null; }
}
originalHandle('linux/preset-save', async (_event, config) => {
  try {
    const file = presetStorePath();
    if (file) fs.writeFileSync(file, JSON.stringify(config || {}), 'utf8');
    return { ok: true };
  } catch (error) {
    log('preset-save failed:', error);
    return { ok: false, error: error.message || String(error) };
  }
});
originalHandle('linux/preset-load', async () => {
  try {
    const file = presetStorePath();
    if (!file || !fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && parsed.digitalData ? parsed : null;
  } catch (error) {
    log('preset-load failed:', error);
    return null;
  }
});
originalHandle('linux/hold-state', async (_event, active) => {
  externalHoldActive = Boolean(active);
  log('external hold state', externalHoldActive);
  return { ok: true, active: externalHoldActive };
});
originalHandle('linux/push-image', async (_event, dataUrl) => {
  log('push-image called');
  const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('需要 PNG data URL');
  const png = Buffer.from(match[1], 'base64');
  if (png.length === 0) throw new Error('图片为空');
  if (png.length > 16 * 1024 * 1024) throw new Error('图片过大');
  return daemonRequest({ action: 'image', data: png.toString('base64') }, 8000);
});
async function captureImageDataUrl(event, rect) {
  const bounds = {
    x: Math.max(0, Math.round(Number(rect?.x) || 0)),
    y: Math.max(0, Math.round(Number(rect?.y) || 0)),
    width: Math.min(4096, Math.max(1, Math.round(Number(rect?.width) || 320))),
    height: Math.min(4096, Math.max(1, Math.round(Number(rect?.height) || 240))),
  };
  const image = await event.sender.capturePage(bounds);
  if (image.isEmpty()) throw new Error('preview capture is empty');
  const png = image.resize({ width: 320, height: 240, quality: 'best' }).toPNG();
  return `data:image/png;base64,${png.toString('base64')}`;
}
originalHandle('linux/capture-image', async (event, rect) => captureImageDataUrl(event, rect));
originalHandle('linux/capture-preview', async (event, rect) => {
  const dataUrl = await captureImageDataUrl(event, rect);
  const match = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('capture returned invalid PNG');
  return daemonRequest({ action: 'image', data: match[1] }, 8000);
});

log('Linux compatibility layer installed', { sockets: SOCKET_CANDIDATES, pid: process.pid });
module.exports = { daemonRequest, daemonStatus, mapSensors, listDisks, systemInfo };
