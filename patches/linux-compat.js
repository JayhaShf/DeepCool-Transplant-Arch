'use strict';

// Linux compatibility layer for the bytecode-only DeepCool 1.2.12 main process.
// It is loaded before out/main/index.jsc and intercepts selected IPC handlers.
// The official renderer and most of the official main process remain unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { fileURLToPath } = require('url');
const execFileAsync = promisify(execFile);
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
      for (const win of windows) hardenWindow(win);
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
const LOG_MAX_BYTES = 5 * 1024 * 1024;
function log(...args) {
  try {
    // 轮转：超过 5MB 时改名留档，避免无限增长（daemon 不可用时每秒数行）
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
    } catch (_) {}
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
const commandCache = new Map();
function execTextCached(file, args = [], ttlMs = 30000) {
  const key = `${file}\0${args.join('\0')}`;
  const now = Date.now();
  const cached = commandCache.get(key);
  if (cached && cached.value !== undefined && now - cached.at < ttlMs) {
    return Promise.resolve(cached.value);
  }
  if (cached && cached.pending) return cached.pending;
  const pending = execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout }) => {
    const value = String(stdout || '').trim();
    commandCache.set(key, { value, at: Date.now(), pending: null });
    return value;
  }).catch(() => {
    commandCache.set(key, { value: '', at: Date.now(), pending: null });
    return '';
  });
  commandCache.set(key, { value: cached && cached.value, at: cached?.at || 0, pending });
  return pending;
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
    socket.on('error', (error) => {
      // socket 现为 0660 root:deepcool；未加入 deepcool 组或未重新登录时 connect 会 EACCES
      const code = error && error.code;
      if (code === 'EACCES' || code === 'EPERM') {
        finish(reject, new Error(
          'deepcool-lm daemon socket permission denied（加入 deepcool 组后重新登录或执行 newgrp deepcool）'
        ));
        return;
      }
      finish(reject, error);
    });
  });
}

// ---- 上传媒体 / 播放配置（Linux 实现）----
// 官方：ImageConfig via l122/playerConfiguration*；媒体库 via getAllMedia 等。
// 默认结构对齐 index-8dc9d6df.js store：playingOrder/playingAnimation/switchTime。
const DEFAULT_IMAGE_CONFIG = {
  playingOrder: 'loop',
  playingAnimation: 'panning',
  switchTime: 3000,
};
const PLAYER_ANIMATIONS = new Set(['static', 'panning', 'ease_in_out']);
const MEDIA_TOTAL_QUOTA_BYTES = 64 * 1024 * 1024;
const MEDIA_ENTRY_QUOTA_BYTES = 10 * 1024 * 1024;
const MEDIA_SOURCE_MAX_BYTES = 128 * 1024 * 1024;
const MEDIA_INDEX_MAX_BYTES = MEDIA_TOTAL_QUOTA_BYTES + 8 * 1024 * 1024;
const MEDIA_LIST_LIMIT = 30;
const MAX_PNG_BYTES = 2 * 1024 * 1024;
const MAX_PNG_BASE64_CHARS = Math.ceil(MAX_PNG_BYTES / 3) * 4;
let playerConfig = { ...DEFAULT_IMAGE_CONFIG };
const mediaStore = { imageList: [], gifList: [], videoList: [] };
let mediaId = 1;
let mediaLoadPromise = null;
let mediaPersistChain = Promise.resolve();
let mediaMutationChain = Promise.resolve();
let mediaBlobBytes = 0;

function userDataFile(name) {
  try { return path.join(app.getPath('userData'), name); } catch (_) { return null; }
}

async function loadJsonFile(name, fallback, maxBytes = 1024 * 1024) {
  try {
    const file = userDataFile(name);
    if (!file) return fallback;
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) return fallback;
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`${name} exceeds the ${maxBytes}-byte read limit`);
    }
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (error) {
    log('loadJson failed', name, error);
    return fallback;
  }
}

async function saveJsonFile(name, value) {
  let temp = null;
  try {
    const file = userDataFile(name);
    if (!file) return false;
    const body = JSON.stringify(value);
    temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temp, file);
    return true;
  } catch (error) {
    log('saveJson failed', name, error);
    if (temp) await fs.promises.unlink(temp).catch(() => {});
    return false;
  }
}

function normalizePlayerConfig(value, previous = DEFAULT_IMAGE_CONFIG) {
  const source = value && typeof value === 'object' ? value : {};
  const animation = PLAYER_ANIMATIONS.has(source.playingAnimation)
    ? source.playingAnimation
    : previous.playingAnimation || DEFAULT_IMAGE_CONFIG.playingAnimation;
  const switchTime = Number(source.switchTime);
  return {
    // The 1.2.12 renderer only defines "loop" and never offers another order.
    playingOrder: 'loop',
    playingAnimation: animation,
    switchTime: Number.isFinite(switchTime) && switchTime > 0
      ? Math.min(60000, Math.max(200, Math.round(switchTime)))
      : previous.switchTime || DEFAULT_IMAGE_CONFIG.switchTime,
  };
}

function playerSupportStatus(config = playerConfig, requested = config) {
  const requestedOrder = requested?.playingOrder || config.playingOrder;
  const requestedAnimation = requested?.playingAnimation || config.playingAnimation;
  return {
    playingOrder: {
      requested: requestedOrder,
      applied: 'loop',
      supported: ['loop'],
      exact: requestedOrder === 'loop',
    },
    playingAnimation: {
      requested: requestedAnimation,
      applied: config.playingAnimation === 'static' ? 'static' : 'cut',
      accepted: [...PLAYER_ANIMATIONS],
      exact: requestedAnimation === 'static' && config.playingAnimation === 'static',
      reason: config.playingAnimation === 'static'
        ? null
        : 'LCD bridge preserves timing but cannot reproduce renderer slide/fade transitions',
    },
    switchTime: { exact: true, min: 200, max: 60000 },
  };
}

function mediaRoot() {
  return userDataFile('media-cache');
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function storedFramePath(relativePath) {
  const root = mediaRoot();
  const base = userDataFile('');
  if (!root || !base || typeof relativePath !== 'string') return null;
  const absolute = path.resolve(base, relativePath);
  return isPathInside(root, absolute) ? absolute : null;
}

async function safeStoredFramePath(relativePath) {
  const candidate = storedFramePath(relativePath);
  if (!candidate) return null;
  const realPath = await fs.promises.realpath(candidate).catch(() => null);
  return realPath && isPathInside(mediaRoot(), realPath) ? realPath : null;
}

function frameFilesOf(entry) {
  return Array.isArray(entry?.frameFiles) ? entry.frameFiles.filter((file) => storedFramePath(file)) : [];
}

function frameBytesOf(entry) {
  const bytes = Number(entry?.frameBytes);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function decodePngDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('媒体帧不是有效的 PNG data URL');
  const encoded = match[1];
  if (encoded.length > MAX_PNG_BASE64_CHARS || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('媒体帧 Base64 编码无效或过大');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_PNG_BYTES) throw new Error('单帧 PNG 大小超限');
  return buffer;
}

async function removeStoredFrames(files) {
  const directories = new Set();
  for (const relativePath of files || []) {
    const absolute = storedFramePath(relativePath);
    if (!absolute) continue;
    directories.add(path.dirname(absolute));
    await fs.promises.unlink(absolute).catch(() => {});
  }
  for (const directory of directories) {
    if (directory !== mediaRoot()) await fs.promises.rmdir(directory).catch(() => {});
  }
}

async function writeStoredFrames(id, dataUrls, reclaimBytes = 0) {
  const buffers = [];
  let totalBytes = 0;
  for (const dataUrl of dataUrls || []) {
    const buffer = decodePngDataUrl(dataUrl);
    totalBytes += buffer.length;
    if (totalBytes > MEDIA_ENTRY_QUOTA_BYTES) {
      throw new Error(`媒体帧超过单项 ${MEDIA_ENTRY_QUOTA_BYTES / 1048576} MiB 配额`);
    }
    buffers.push(buffer);
  }
  if (!buffers.length) throw new Error('媒体没有可保存的帧');
  const projected = Math.max(0, mediaBlobBytes - Math.max(0, reclaimBytes)) + totalBytes;
  if (projected > MEDIA_TOTAL_QUOTA_BYTES) {
    throw new Error(`媒体库超过总计 ${MEDIA_TOTAL_QUOTA_BYTES / 1048576} MiB 配额，请先删除旧媒体`);
  }

  const root = mediaRoot();
  const base = userDataFile('');
  if (!root || !base) throw new Error('无法确定媒体缓存目录');
  const token = `${String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const directory = path.join(root, token);
  const relativeFiles = [];
  try {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < buffers.length; index += 1) {
      const absolute = path.join(directory, `frame-${String(index).padStart(3, '0')}.png`);
      await fs.promises.writeFile(absolute, buffers[index], { mode: 0o600 });
      relativeFiles.push(path.relative(base, absolute));
    }
    return { frameFiles: relativeFiles, frameBytes: totalBytes };
  } catch (error) {
    await removeStoredFrames(relativeFiles);
    await fs.promises.rmdir(directory).catch(() => {});
    throw error;
  }
}

function publicMediaEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const result = { ...entry, hasPlayback: frameFilesOf(entry).length > 0 };
  delete result.frameFiles;
  delete result.frameBytes;
  delete result.frames;
  delete result.frameDataUrl;
  return result;
}

function publicMediaStore() {
  return {
    imageList: mediaStore.imageList.map(publicMediaEntry),
    gifList: mediaStore.gifList.map(publicMediaEntry),
    videoList: mediaStore.videoList.map(publicMediaEntry),
  };
}

function allMediaEntries() {
  return [mediaStore.imageList, mediaStore.gifList, mediaStore.videoList].flat();
}

async function validateStoredFrameReferences() {
  mediaBlobBytes = 0;
  for (const entry of allMediaEntries()) {
    const valid = [];
    let bytes = 0;
    for (const relativePath of frameFilesOf(entry)) {
      const absolute = await safeStoredFramePath(relativePath);
      const stat = absolute ? await fs.promises.stat(absolute).catch(() => null) : null;
      if (!stat || !stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) continue;
      if (mediaBlobBytes + bytes + stat.size > MEDIA_TOTAL_QUOTA_BYTES) continue;
      valid.push(relativePath);
      bytes += stat.size;
    }
    entry.frameFiles = valid;
    entry.frameBytes = bytes;
    entry.frameCount = valid.length;
    mediaBlobBytes += bytes;
  }
}

async function migrateEmbeddedFrames() {
  let changed = false;
  for (const entry of allMediaEntries()) {
    const legacyFrames = Array.isArray(entry.frames) && entry.frames.length
      ? entry.frames.filter(Boolean)
      : (entry.frameDataUrl ? [entry.frameDataUrl] : []);
    delete entry.frames;
    delete entry.frameDataUrl;
    if (!legacyFrames.length || frameFilesOf(entry).length) continue;
    try {
      const stored = await writeStoredFrames(entry.id, legacyFrames, 0);
      entry.frameFiles = stored.frameFiles;
      entry.frameBytes = stored.frameBytes;
      entry.frameCount = stored.frameFiles.length;
      mediaBlobBytes += stored.frameBytes;
    } catch (error) {
      entry.frameFiles = [];
      entry.frameBytes = 0;
      entry.frameCount = 0;
      log('legacy media frame migration skipped', entry.id, error);
    }
    changed = true;
  }
  return changed;
}

function persistMediaStore() {
  const snapshot = publicMediaStore();
  // Keep the private frame references in the on-disk index, but never send
  // them (or frame payloads) through getAllMedia.
  for (const key of ['imageList', 'gifList', 'videoList']) {
    snapshot[key] = mediaStore[key].map((entry) => {
      const value = { ...entry, frameFiles: frameFilesOf(entry), frameBytes: frameBytesOf(entry) };
      delete value.frames;
      delete value.frameDataUrl;
      delete value.hasPlayback;
      return value;
    });
  }
  const write = () => saveJsonFile('media-store.json', snapshot).then((saved) => {
    if (!saved) throw new Error('媒体索引写入失败');
  });
  const next = mediaPersistChain.then(write, write);
  mediaPersistChain = next.catch(() => {});
  return next;
}

function persistPlayerConfig() {
  const snapshot = { ...playerConfig };
  const write = () => saveJsonFile('player-config.json', snapshot).then((saved) => {
    if (!saved) throw new Error('播放配置写入失败');
  });
  const next = mediaPersistChain.then(write, write);
  mediaPersistChain = next.catch(() => {});
  return next;
}

function ensureMediaPersistLoaded() {
  if (mediaLoadPromise) return mediaLoadPromise;
  mediaLoadPromise = (async () => {
    const savedPlayer = await loadJsonFile('player-config.json', null);
    if (savedPlayer && typeof savedPlayer === 'object') {
      playerConfig = normalizePlayerConfig(savedPlayer);
    }
    const savedMedia = await loadJsonFile('media-store.json', null, MEDIA_INDEX_MAX_BYTES);
    if (savedMedia && typeof savedMedia === 'object') {
      mediaStore.imageList = Array.isArray(savedMedia.imageList) ? savedMedia.imageList : [];
      mediaStore.gifList = Array.isArray(savedMedia.gifList) ? savedMedia.gifList : [];
      mediaStore.videoList = Array.isArray(savedMedia.videoList) ? savedMedia.videoList : [];
    }
    await validateStoredFrameReferences();
    const migrated = await migrateEmbeddedFrames();
    if (migrated) await persistMediaStore();
  })().catch((error) => {
    log('media persistence initialization failed', error);
  });
  return mediaLoadPromise;
}

function mediaFromUpload(data, serialNumber) {
  const type = String(data?.mediaType || 'image').toLowerCase();
  const pathValue = data?.path || data?.originalPath || '';
  const isGif = type === 'gif' || /\.gif$/i.test(pathValue);
  const mediaType = type === 'video' ? 'video' : (isGif ? 'gif' : 'image');
  const bucket = mediaType === 'gif' ? 'gifList' : (mediaType === 'video' ? 'videoList' : 'imageList');
  let id = data?.id != null ? String(data.id) : String(Date.now() + mediaId++);
  while (data?.id == null && allMediaEntries().some((entry) => String(entry.id) === id)) {
    id = String(Date.now() + mediaId++);
  }
  // 同一时间只保留一个 isCurrent
  for (const list of [mediaStore.imageList, mediaStore.gifList, mediaStore.videoList]) {
    for (const entry of list) entry.isCurrent = false;
  }
  // modify：同 id 则更新
  let item = null;
  let replaced = null;
  for (const list of [mediaStore.imageList, mediaStore.gifList, mediaStore.videoList]) {
    const idx = list.findIndex((m) => String(m.id) === id);
    if (idx >= 0) {
      replaced = list[idx];
      item = {
        ...list[idx],
        mediaType,
        elementPath: pathValue || list[idx].elementPath,
        firstFramePath: pathValue || list[idx].firstFramePath,
        path: pathValue || list[idx].path || list[idx].elementPath,
        name: (pathValue && pathValue.split('/').pop()) || list[idx].name || 'image',
        isCurrent: true,
        serialNumber: serialNumber || list[idx].serialNumber,
        updatedAt: Date.now(),
      };
      // 类型桶变化时迁移
      if (list !== mediaStore[bucket]) {
        list.splice(idx, 1);
        mediaStore[bucket].push(item);
      } else {
        list[idx] = item;
      }
      break;
    }
  }
  if (!item) {
    item = {
      id,
      mediaType,
      elementPath: pathValue,
      firstFramePath: pathValue,
      path: pathValue,
      name: pathValue.split('/').pop() || 'image',
      isCurrent: true,
      serialNumber,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mediaStore[bucket].push(item);
  }
  const evicted = [];
  if (mediaStore[bucket].length > MEDIA_LIST_LIMIT) {
    evicted.push(...mediaStore[bucket].slice(0, -MEDIA_LIST_LIMIT));
    mediaStore[bucket] = mediaStore[bucket].slice(-MEDIA_LIST_LIMIT);
  }
  return { item, bucket, replaced, evicted };
}

function currentMediaList() {
  for (const list of [mediaStore.imageList, mediaStore.gifList, mediaStore.videoList]) {
    const cur = list.find((m) => m && m.isCurrent);
    if (cur) return [publicMediaEntry(cur)];
  }
  return [];
}

function queueMediaMutation(task) {
  const next = mediaMutationChain.then(task, task);
  mediaMutationChain = next.catch(() => {});
  return next;
}

let ffmpegLookupPromise = null;
function findFfmpeg() {
  if (ffmpegLookupPromise) return ffmpegLookupPromise;
  ffmpegLookupPromise = (async () => {
    for (const bin of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/sbin/ffmpeg']) {
      try {
        await execFileAsync(bin, ['-version'], { timeout: 2000, maxBuffer: 256 * 1024 });
        return bin;
      } catch (_) {}
    }
    return null;
  })();
  return ffmpegLookupPromise;
}

let ffprobeLookupPromise = null;
function findFfprobe() {
  if (ffprobeLookupPromise) return ffprobeLookupPromise;
  ffprobeLookupPromise = (async () => {
    for (const bin of ['ffprobe', '/usr/bin/ffprobe', '/usr/sbin/ffprobe']) {
      try {
        await execFileAsync(bin, ['-version'], { timeout: 2000, maxBuffer: 256 * 1024 });
        return bin;
      } catch (_) {}
    }
    return null;
  })();
  return ffprobeLookupPromise;
}

async function probeMediaDimensions(filePath) {
  const ffprobe = await findFfprobe();
  if (!ffprobe) throw new Error('未找到 ffprobe，无法安全检查媒体尺寸（pacman -S ffmpeg）');
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', filePath,
  ], { timeout: 10000, maxBuffer: 256 * 1024 });
  const match = String(stdout || '').trim().match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error('无法读取媒体像素尺寸');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384
    || width * height > 64 * 1024 * 1024) {
    throw new Error('媒体像素尺寸超限');
  }
  return { width, height };
}

async function pngFileToDataUrl(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.length || buffer.length > 2 * 1024 * 1024
    || buffer.length < pngSignature.length || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error('ffmpeg 输出的 PNG 帧无效或过大');
  }
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function processImageToFrame(data, dimensions) {
  const filePath = data?.path || data?.originalPath || '';
  if (!filePath) throw new Error('上传数据缺少文件路径');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法安全解析图片（pacman -S ffmpeg）');
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepcool-image-'));
  const output = path.join(tmpRoot, 'frame.png');
  try {
    const cx = Math.round(Number(data?.positionX));
    const cy = Math.round(Number(data?.positionY));
    const cw = Math.round(Number(data?.cutWidth));
    const ch = Math.round(Number(data?.cutHeight));
    const canCrop = [cx, cy, cw, ch].every(Number.isFinite)
      && cx >= 0 && cy >= 0 && cw > 0 && ch > 0
      && cx + cw <= dimensions.width && cy + ch <= dimensions.height;
    const crop = canCrop ? `crop=${cw}:${ch}:${cx}:${cy},` : '';
    const vf = `${crop}scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2`;
    await execFileAsync(ffmpeg, [
      '-v', 'error', '-nostdin', '-threads', '1', '-max_alloc', String(64 * 1024 * 1024),
      '-y', '-i', filePath, '-map', '0:v:0', '-frames:v', '1', '-vf', vf, output,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    return await pngFileToDataUrl(output);
  } finally {
    await fs.promises.unlink(output).catch(() => {});
    await fs.promises.rmdir(tmpRoot).catch(() => {});
  }
}

// GIF/视频 → 多帧 PNG dataURL。官方 ImageConfig.switchTime 控制切换间隔（默认 3s）。
// 限制帧数与时长，避免 userData/推帧过重。
async function extractMediaFrames(filePath, { kind = 'gif', maxFrames = 24, maxSeconds = 8 } = {}) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('未找到 ffmpeg，无法解析 GIF/视频（pacman -S ffmpeg）');
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deepcool-media-'));
  const pattern = path.join(tmpRoot, 'frame_%03d.png');
  try {
    // 统一缩放到 320x240，控制输出帧率：GIF 用源帧率但 cap；视频约 4fps 抽帧
    const vf = kind === 'video'
      ? 'fps=4,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2'
      : 'scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2';
    const args = [
      '-v', 'error', '-nostdin', '-threads', '1', '-max_alloc', String(64 * 1024 * 1024),
      '-y', '-i', filePath, '-map', '0:v:0', '-t', String(maxSeconds), '-vf', vf, '-frames:v', String(maxFrames), pattern,
    ];
    await execFileAsync(ffmpeg, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const files = fs.readdirSync(tmpRoot)
      .filter((n) => /^frame_\d+\.png$/.test(n))
      .sort()
      .map((n) => path.join(tmpRoot, n));
    if (!files.length) throw new Error('未能从媒体中抽出任何帧');
    const frames = [];
    let totalFrameBytes = 0;
    for (const f of files) {
      const stat = await fs.promises.stat(f);
      totalFrameBytes += stat.size;
      if (totalFrameBytes > MEDIA_ENTRY_QUOTA_BYTES) {
        throw new Error(`媒体帧超过单项 ${MEDIA_ENTRY_QUOTA_BYTES / 1048576} MiB 配额`);
      }
      const url = await pngFileToDataUrl(f);
      if (url) frames.push(url);
    }
    if (!frames.length) throw new Error('抽出的帧无法解码为 PNG');
    return frames;
  } finally {
    const names = await fs.promises.readdir(tmpRoot).catch(() => []);
    await Promise.all(names.map((name) => fs.promises.unlink(path.join(tmpRoot, name)).catch(() => {})));
    await fs.promises.rmdir(tmpRoot).catch(() => {});
  }
}

const grantedMediaPaths = new Map();
const MEDIA_GRANT_TTL_MS = 15 * 60 * 1000;

async function canonicalRegularFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new Error('媒体路径必须是本地绝对路径');
  }
  const realPath = await fs.promises.realpath(filePath);
  const stat = await fs.promises.stat(realPath);
  if (!stat.isFile()) throw new Error('媒体路径不是普通文件');
  if (stat.size <= 0 || stat.size > MEDIA_SOURCE_MAX_BYTES) {
    throw new Error(`媒体源文件大小必须在 1 字节到 ${MEDIA_SOURCE_MAX_BYTES / 1048576} MiB 之间`);
  }
  return { realPath, size: stat.size };
}

async function grantSelectedMediaPath(filePath) {
  const { realPath } = await canonicalRegularFile(filePath);
  grantedMediaPaths.set(realPath, Date.now() + MEDIA_GRANT_TTL_MS);
  return realPath;
}

async function assertAllowedMediaPath(filePath) {
  const { realPath } = await canonicalRegularFile(filePath);
  const now = Date.now();
  for (const [granted, expiresAt] of grantedMediaPaths) {
    if (expiresAt <= now) grantedMediaPaths.delete(granted);
  }
  const granted = (grantedMediaPaths.get(realPath) || 0) > now;
  let persisted = false;
  if (!granted) {
    for (const entry of allMediaEntries()) {
      const known = entry && (entry.elementPath || entry.path);
      if (!known || typeof known !== 'string') continue;
      try {
        if (await fs.promises.realpath(known) === realPath) {
          persisted = true;
          break;
        }
      } catch (_) {}
    }
  }
  if (!granted && !persisted) {
    throw new Error('媒体路径未由文件选择器授权，也不属于已保存的媒体');
  }
  return realPath;
}

async function readPlaybackFrames(entry) {
  const frames = [];
  let total = 0;
  for (const relativePath of frameFilesOf(entry)) {
    const absolute = await safeStoredFramePath(relativePath);
    if (!absolute) continue;
    const buffer = await fs.promises.readFile(absolute);
    total += buffer.length;
    if (!buffer.length || buffer.length > 2 * 1024 * 1024 || total > MEDIA_ENTRY_QUOTA_BYTES) {
      throw new Error('已保存的媒体帧超过读取配额');
    }
    frames.push(`data:image/png;base64,${buffer.toString('base64')}`);
  }
  return frames;
}

async function playbackForEntry(entry, existingFrames = null) {
  if (!entry) return null;
  let frames = Array.isArray(existingFrames) && existingFrames.length
    ? existingFrames
    : await readPlaybackFrames(entry);
  let playlistTotal = 1;
  let playlistTruncated = false;
  if (entry.mediaType === 'image' && playerConfig.playingAnimation !== 'static') {
    const selectedIndex = mediaStore.imageList.indexOf(entry);
    const ordered = selectedIndex >= 0
      ? mediaStore.imageList.slice(selectedIndex).concat(mediaStore.imageList.slice(0, selectedIndex))
      : [entry];
    playlistTotal = ordered.length;
    const playlist = [];
    let playlistBytes = 0;
    for (const item of ordered) {
      const itemFrames = item === entry && frames.length ? frames : await readPlaybackFrames(item);
      if (!itemFrames.length) continue;
      const itemBytes = frameBytesOf(item) || Math.ceil(itemFrames[0].length * 3 / 4);
      if (playlistBytes + itemBytes > MEDIA_ENTRY_QUOTA_BYTES) {
        playlistTruncated = true;
        break;
      }
      playlist.push(itemFrames[0]);
      playlistBytes += itemBytes;
    }
    if (playlist.length) frames = playlist;
  } else if (entry.mediaType === 'image' && frames.length > 1) {
    frames = [frames[0]];
  }
  const support = playerSupportStatus();
  support.playlist = {
    mediaType: entry.mediaType,
    included: frames.length,
    total: playlistTotal,
    truncated: playlistTruncated,
  };
  if (!frames.length) return {
    selected: true,
    frameDataUrl: null,
    frames: [],
    media: publicMediaEntry(entry),
    intervalMs: playerConfig.switchTime,
    playerConfig: { ...playerConfig },
    support,
  };
  return {
    selected: true,
    frameDataUrl: frames[0],
    frames,
    media: publicMediaEntry(entry),
    intervalMs: playerConfig.switchTime,
    playerConfig: { ...playerConfig },
    support,
  };
}

async function processMediaUpload(media, serialNumber, { kind = 'image', id } = {}) {
  const requestedPath = media?.path || media?.originalPath || '';
  const pathValue = await assertAllowedMediaPath(requestedPath);
  const dimensions = await probeMediaDimensions(pathValue);
  const lower = String(pathValue).toLowerCase();
  const isGif = kind === 'gif' || lower.endsWith('.gif') || String(media?.mediaType || '').toLowerCase() === 'gif';
  const isVideo = kind === 'video'
    || /\.(mp4|webm|avi|mkv|mov|m4v)$/i.test(pathValue)
    || String(media?.mediaType || '').toLowerCase() === 'video';

  let frames = [];
  let frameDataUrl = null;
  if (isGif || isVideo) {
    frames = await extractMediaFrames(pathValue, {
      kind: isVideo ? 'video' : 'gif',
      maxFrames: isVideo ? 20 : 24,
      maxSeconds: isVideo ? 6 : 8,
    });
    frameDataUrl = frames[0];
  } else {
    frameDataUrl = await processImageToFrame({ ...(media || {}), path: pathValue, originalPath: pathValue }, dimensions);
    frames = [frameDataUrl];
  }

  const payload = {
    ...(media || {}),
    id: id || media?.id,
    path: pathValue,
    originalPath: pathValue,
    mediaType: isVideo ? 'video' : (isGif ? 'gif' : 'image'),
  };
  return queueMediaMutation(async () => {
    const backup = {
      imageList: mediaStore.imageList.map((entry) => ({ ...entry })),
      gifList: mediaStore.gifList.map((entry) => ({ ...entry })),
      videoList: mediaStore.videoList.map((entry) => ({ ...entry })),
    };
    const previousBlobBytes = mediaBlobBytes;
    let stored = null;
    try {
      const { item, replaced, evicted } = mediaFromUpload(payload, serialNumber);
      const reclaimedEntries = [replaced, ...evicted].filter(Boolean);
      const reclaimedFiles = [...new Set(reclaimedEntries.flatMap(frameFilesOf))];
      const reclaimedBytes = reclaimedEntries.reduce((sum, entry) => sum + frameBytesOf(entry), 0);
      stored = await writeStoredFrames(item.id, frames, reclaimedBytes);
      item.frameFiles = stored.frameFiles;
      item.frameBytes = stored.frameBytes;
      item.frameCount = stored.frameFiles.length;
      await persistMediaStore();
      mediaBlobBytes = Math.max(0, previousBlobBytes - reclaimedBytes) + stored.frameBytes;
      await removeStoredFrames(reclaimedFiles);
      grantedMediaPaths.delete(pathValue);
      return await playbackForEntry(item, frames);
    } catch (error) {
      if (stored) await removeStoredFrames(stored.frameFiles);
      mediaStore.imageList = backup.imageList;
      mediaStore.gifList = backup.gifList;
      mediaStore.videoList = backup.videoList;
      mediaBlobBytes = previousBlobBytes;
      throw error;
    }
  });
}

let statusCache = null;
let statusAt = 0;
let statusPending = null;
let externalHoldActive = false;

async function daemonStatus() {
  const now = Date.now();
  if (statusCache && now - statusAt < 700) return statusCache;
  if (statusPending) return statusPending;
  // 两个并发调用（linux/status 与 app/get-sensors-data 同时冷 cache）时，
  // 后到者复用同一 in-flight 请求，避免 statusPending 被覆盖导致的请求风暴。
  // 注意：Python daemon 始终采样，这里只读 status，不再副作用切 monitor
  // （旧逻辑会在 hold 间隙把 LCD 刷黑）。
  statusPending = daemonRequest({ action: 'status' })
    .then((status) => {
      // 仅当响应含 snapshot 时缓存（zen 等命令的响应没有 snapshot，
      // 直接缓存会让 700ms 内传感器读数短暂归零）
      if (status && status.snapshot) {
        statusCache = status;
        statusAt = Date.now();
      }
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
  // Prefer physical interfaces; TUN/bridge/veth/WireGuard counters overlap
  // with the underlying NIC and would otherwise be double-counted.
  const physicalNets = netRows.filter((row) => !/^(Meta|lo|docker|bridge|veth|virbr|br-|tun|tap|wg|tailscale|ppp|wwan)/i.test(String(row.name || '')));
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
  cachedGpuName = 'GPU';
  execTextCached('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 5 * 60 * 1000)
    .then((output) => { cachedGpuName = output.split('\n')[0] || cachedGpuName; });
  return cachedGpuName;
}
let cachedMemoryClock;
function memoryClock() {
  if (cachedMemoryClock !== undefined) return cachedMemoryClock;
  cachedMemoryClock = 0;
  execTextCached('dmidecode', ['--type', 'memory'], 60 * 60 * 1000).then((output) => {
    const speeds = [...output.matchAll(/^\s*Configured Memory Speed:\s*(\d+)\s*MT\/s/gm)].map((m) => Number(m[1]));
    if (speeds.length) cachedMemoryClock = Math.max(...speeds);
  });
  return cachedMemoryClock;
}

async function systemInfo() {
  const board = [readText('/sys/devices/virtual/dmi/id/board_vendor'), readText('/sys/devices/virtual/dmi/id/board_name')].filter(Boolean).join(' ');
  const [nvidiaText, disks] = await Promise.all([
    execTextCached('nvidia-smi', ['--query-gpu=name,pci.bus_id', '--format=csv,noheader,nounits'], 5 * 60 * 1000),
    listDisks(),
  ]);
  const nvidia = nvidiaText.split('\n').filter(Boolean);
  const gpu = nvidia.map((line, index) => {
    const comma = line.lastIndexOf(',');
    return {
      name: (comma >= 0 ? line.slice(0, comma) : line).trim(),
      bus: 'PCIe 4.0 x16',
      busId: comma >= 0 ? line.slice(comma + 1).trim() : '',
      default: index === 0,
    };
  });
  if (gpu[0]?.name) cachedGpuName = gpu[0].name;
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
    diskName: disks.map((d) => d.name),
    diskSingle: disks,
  };
}

async function listDisks() {
  const rows = [];
  const seen = new Set();
  const output = await execTextCached(
    'df',
    ['-B1', '--output=source,size,used,avail,pcent,target', '-x', 'tmpfs', '-x', 'devtmpfs'],
    5000
  );
  for (const line of output.split('\n').slice(1)) {
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
let lastRendererPushedDataUrl = BLACK_320_240_PNG;

function trustedRendererRoots() {
  const roots = [];
  try { roots.push(path.resolve(app.getAppPath())); } catch (_) {}
  if (path.basename(__dirname) === 'main' && path.basename(path.dirname(__dirname)) === 'out') {
    roots.push(path.resolve(__dirname, '..', '..'));
  }
  return [...new Set(roots)];
}

function isTrustedRendererUrl(rawUrl, roots = trustedRendererRoots()) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    const filePath = fileURLToPath(parsed);
    return roots.some((root) => {
      const relative = path.relative(path.resolve(root), path.resolve(filePath));
      return relative === path.join('out', 'renderer', 'index.html')
        || relative === path.join('out', 'renderer', 'launch.html');
    });
  } catch (_) {
    return false;
  }
}

function hardenWindow(win) {
  try {
    const webContents = win.webContents;
    if (webContents.__deepcoolLinuxHardened) return;
    webContents.__deepcoolLinuxHardened = true;
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    webContents.on('will-navigate', (event, url) => {
      if (!isTrustedRendererUrl(url)) event.preventDefault();
    });
  } catch (error) {
    log('window hardening failed', error);
  }
}

app.on('browser-window-created', (_event, win) => hardenWindow(win));

function isTrustedIpcSender(event) {
  let frame = event && event.senderFrame;
  for (let depth = 0; frame && depth < 8; depth += 1) {
    if (isTrustedRendererUrl(frame.url)) return true;
    // about:blank child frames inherit the trusted file origin. Other
    // protocols must never gain IPC access merely through parentage.
    if (frame.url !== 'about:blank') return false;
    frame = frame.parent;
  }
  try { return isTrustedRendererUrl(event?.sender?.getURL()); } catch (_) { return false; }
}

function assertTrustedIpcSender(event, channel) {
  if (isTrustedIpcSender(event)) return;
  let senderUrl = '';
  try { senderUrl = event?.senderFrame?.url || event?.sender?.getURL() || ''; } catch (_) {}
  log('blocked untrusted IPC sender', channel, senderUrl);
  const error = new Error(`拒绝来自非应用页面的 IPC: ${channel}`);
  error.code = 'ERR_UNTRUSTED_IPC_SENDER';
  throw error;
}

const rawHandle = ipcMain.handle.bind(ipcMain);
function originalHandle(channel, listener) {
  return rawHandle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event, channel);
    return listener(event, ...args);
  });
}

function selectedMediaEntry(elements) {
  const element = Array.isArray(elements) ? elements[0] : elements;
  if (!element || typeof element !== 'object') return null;
  const rawId = element.id;
  const id = rawId == null || String(rawId) === 'NaN' ? null : String(rawId);
  const paths = [];
  if (Array.isArray(element?.element?.data)) paths.push(...element.element.data.filter((value) => typeof value === 'string'));
  if (typeof element.elementPath === 'string') paths.push(element.elementPath);
  if (typeof element.path === 'string') paths.push(element.path);
  return allMediaEntries().find((entry) => (
    (id != null && String(entry.id) === id)
    || paths.includes(entry.elementPath)
    || paths.includes(entry.path)
  )) || null;
}

const overrides = {
  'app/get-sensors-data': {
    mode: 'replace',
    fn: async () => ok(mapSensors(await daemonStatus())),
  },
  'app/get-systeminfo': {
    mode: 'replace',
    fn: async () => ok(await systemInfo()),
  },
  'app/get-disk-list': {
    mode: 'replace',
    fn: async () => ok(await listDisks()),
  },
  'app/set-setting': {
    mode: 'wrap',
    fn: async (original, event, setting, ...args) => {
      if (setting && typeof setting === 'object' && 'launch' in setting) {
        const want = setting.launch === true || setting.launch === 'true';
        await setAutostartEnabled(want);
      }
      return original(event, setting, ...args);
    },
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
    fn: async () => lastRendererPushedDataUrl,
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
      const granted = await Promise.all(result.filePaths.map(grantSelectedMediaPath));
      return ok({ filePaths: granted });
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
      const granted = await Promise.all(result.filePaths.map(grantSelectedMediaPath));
      return ok({ filePaths: granted });
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
      const granted = await Promise.all(result.filePaths.map(grantSelectedMediaPath));
      return ok({ filePaths: granted });
    },
  },
  'l122/uploadSelectedMedia': {
    mode: 'replace',
    fn: async (_event, media, serialNumber) => {
      try {
        await ensureMediaPersistLoaded();
        const result = await processMediaUpload(media || {}, serialNumber, { kind: 'image' });
        log('upload media ok', result.media.elementPath, 'frames', result.frames.length);
        return ok(result);
      } catch (error) {
        log('upload media failed:', error);
        return { code: 1, message: error.message || String(error), data: null };
      }
    },
  },
  'l122/modifyMedia': {
    mode: 'replace',
    fn: async (_event, media, id, serialNumber) => {
      try {
        await ensureMediaPersistLoaded();
        const result = await processMediaUpload(media || {}, serialNumber, {
          kind: 'image',
          id: id || media?.id,
        });
        log('modify media ok', result.media.elementPath, 'frames', result.frames.length);
        return ok(result);
      } catch (error) {
        log('modify media failed:', error);
        return { code: 1, message: error.message || String(error), data: null };
      }
    },
  },
  'l122/uploadSelectedVideo': {
    mode: 'replace',
    fn: async (_event, media, serialNumber) => {
      try {
        await ensureMediaPersistLoaded();
        const result = await processMediaUpload(media || {}, serialNumber, { kind: 'video' });
        log('upload video ok', result.media.elementPath, 'frames', result.frames.length);
        // 官方视频链路期望结构可能不同；提供 frameDataUrl/frames 供 overlay 轮播
        return ok(result);
      } catch (error) {
        log('upload video failed:', error);
        return {
          code: 1,
          message: error.message || String(error) || '视频处理失败（需 ffmpeg）',
          data: null,
        };
      }
    },
  },
  'l122/modifyVideo': {
    mode: 'replace',
    fn: async (_event, media, id, serialNumber) => {
      try {
        await ensureMediaPersistLoaded();
        const result = await processMediaUpload(media || {}, serialNumber, {
          kind: 'video',
          id: id || media?.id,
        });
        log('modify video ok', result.media.elementPath, 'frames', result.frames.length);
        return ok(result);
      } catch (error) {
        log('modify video failed:', error);
        return { code: 1, message: error.message || String(error), data: null };
      }
    },
  },
  'l122/getAllMedia': {
    mode: 'replace',
    fn: async () => {
      await ensureMediaPersistLoaded();
      return ok(publicMediaStore());
    },
  },
  'l122/deleteOneMedia': {
    mode: 'replace',
    fn: async (_event, id) => {
      await ensureMediaPersistLoaded();
      return queueMediaMutation(async () => {
        const removed = [];
        for (const key of ['imageList', 'gifList', 'videoList']) {
          removed.push(...mediaStore[key].filter((m) => String(m.id) === String(id)));
          mediaStore[key] = mediaStore[key].filter((m) => String(m.id) !== String(id));
        }
        await persistMediaStore();
        mediaBlobBytes = Math.max(0, mediaBlobBytes - removed.reduce((sum, entry) => sum + frameBytesOf(entry), 0));
        await removeStoredFrames(removed.flatMap(frameFilesOf));
        return ok(removed.length > 0);
      });
    },
  },
  // 官方 getCurrentMedia → getElementDataCurrent；store 赋给 currentData
  'l122/getElementDataCurrent': {
    mode: 'replace',
    fn: async () => {
      await ensureMediaPersistLoaded();
      return ok(currentMediaList());
    },
  },
  'l122/setElementDataCurrent': {
    mode: 'replace',
    fn: async (_event, serialNumber, elements) => {
      await ensureMediaPersistLoaded();
      return queueMediaMutation(async () => {
        const selected = selectedMediaEntry(elements);
        if (!selected) {
          return { code: 1, message: '未找到所选媒体，当前播放项保持不变', data: null };
        }
        for (const entry of allMediaEntries()) entry.isCurrent = entry === selected;
        if (serialNumber) selected.serialNumber = serialNumber;
        selected.updatedAt = Date.now();
        await persistMediaStore();
        return ok(await playbackForEntry(selected));
      });
    },
  },
  // 官方 ImageConfig：playingOrder / playingAnimation / switchTime
  'l122/playerConfigurationSearch': {
    mode: 'replace',
    fn: async () => {
      await ensureMediaPersistLoaded();
      return ok({ ...playerConfig, support: playerSupportStatus() });
    },
  },
  'l122/playerConfigurationSet': {
    mode: 'replace',
    fn: async (_event, value) => {
      await ensureMediaPersistLoaded();
      playerConfig = normalizePlayerConfig(value, playerConfig);
      await persistPlayerConfig();
      log('playerConfigurationSet', playerConfig);
      return ok({ ...playerConfig, support: playerSupportStatus(playerConfig, value) });
    },
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
  // 用户可见命令仅保留 status/zen（监控/亮度切换已按要求移除）。
  const allowed = new Set(['status', 'zen']);
  if (!allowed.has(payload.action)) throw new Error(`Linux bridge 不允许命令: ${payload.action}`);
  delete payload.data;
  delete payload.color;
  const response = await daemonRequest(payload);
  // 仅当响应含 snapshot 时才写入缓存：zen 等命令的响应没有 snapshot，
  // 直接缓存会让 700ms 内 mapSensors 读到空快照（传感器读数短暂归零）。
  if (response && response.snapshot) {
    statusCache = response;
    statusAt = Date.now();
  }
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
originalHandle('linux/media-playback', async (_event, request) => {
  await ensureMediaPersistLoaded();
  const requestedId = request && typeof request === 'object' ? request.id : request;
  const entry = requestedId != null
    ? allMediaEntries().find((item) => String(item.id) === String(requestedId))
    : allMediaEntries().find((item) => item && item.isCurrent);
  return entry ? ok(await playbackForEntry(entry)) : ok(null);
});
// 个性化设置持久化：重启软件后自动恢复 LCD 显示内容
originalHandle('linux/preset-save', async (_event, config) => {
  try {
    const saved = await saveJsonFile('preset.json', config || {});
    return saved ? { ok: true } : { ok: false, error: 'preset write failed' };
  } catch (error) {
    log('preset-save failed:', error);
    return { ok: false, error: error.message || String(error) };
  }
});
originalHandle('linux/preset-load', async () => {
  try {
    const parsed = await loadJsonFile('preset.json', null, 256 * 1024);
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
// 开机自启：与 scripts/install-autostart.sh 写入同一 XDG autostart 文件，
// 软件内开关与命令行脚本互操作（同文件，状态互相可见）。
const AUTOSTART_DIR = path.join(os.homedir(), '.config', 'autostart');
const AUTOSTART_FILE = path.join(AUTOSTART_DIR, 'deepcool-official-linux.desktop');
const AUTOSTART_BIN = path.join(os.homedir(), '.local', 'bin', 'deepcool-official-linux');
function desktopExecPath(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function autostartDesktopContent() {
  return `[Desktop Entry]
Type=Application
Name=DeepCool (Linux Port) Autostart
Name[zh_CN]=DeepCool（Linux 移植版）开机自启
Comment=Start DeepCool official UI in background (tray) at login
Exec=${desktopExecPath(AUTOSTART_BIN)} --hidden
Icon=deepcool-official-linux
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
StartupNotify=false
`;
}
function autostartBinReady() {
  try {
    fs.accessSync(AUTOSTART_BIN, fs.constants.X_OK);
    return true;
  } catch (_) { return false; }
}
async function setAutostartEnabled(want) {
  if (want) {
    if (!autostartBinReady()) {
      throw new Error('未找到启动器（或不可执行），请先运行: npm run install:user');
    }
    let temp = null;
    try {
      await fs.promises.mkdir(AUTOSTART_DIR, { recursive: true });
      temp = `${AUTOSTART_FILE}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(temp, autostartDesktopContent(), { mode: 0o644 });
      await fs.promises.rename(temp, AUTOSTART_FILE);
    } catch (error) {
      if (temp) await fs.promises.unlink(temp).catch(() => {});
      throw new Error(`写入开机自启文件失败: ${error.message || error}`);
    }
    log('autostart enabled', AUTOSTART_FILE);
  } else {
    await fs.promises.unlink(AUTOSTART_FILE).catch((error) => {
      if (error && error.code !== 'ENOENT') throw error;
    });
    log('autostart disabled', AUTOSTART_FILE);
  }
  return { ok: true, enabled: fs.existsSync(AUTOSTART_FILE), path: AUTOSTART_FILE };
}
originalHandle('linux/autostart-status', async () => ({
  enabled: fs.existsSync(AUTOSTART_FILE),
  path: AUTOSTART_FILE,
  binExists: autostartBinReady(),
}));
originalHandle('linux/autostart-set', async (_event, request) => {
  const want = Boolean(request && typeof request === 'object' ? request.enabled : request);
  return setAutostartEnabled(want);
});
// 推图串行化：避免 overlay/多路同时打满 socket + USB
let pushImageChain = Promise.resolve();
originalHandle('linux/push-image', async (_event, dataUrl) => {
  const run = async () => {
    const match = String(dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error('需要 PNG data URL');
    const encoded = match[1];
    if (encoded.length > MAX_PNG_BASE64_CHARS || encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('图片 Base64 编码无效或过大');
    }
    const png = Buffer.from(encoded, 'base64');
    if (png.length === 0) throw new Error('图片为空');
    if (png.length > MAX_PNG_BYTES) throw new Error('图片过大（最大 2MiB）');
    // 超时略放宽：daemon 解码 PNG 时可能短暂忙
    const response = await daemonRequest({
      action: 'image',
      data: png.toString('base64'),
      confirm_timeout_ms: 2000,
    }, 12000);
    if (response && response.ok && response.delivered !== false) lastRendererPushedDataUrl = dataUrl;
    return response;
  };
  const next = pushImageChain.then(run, run);
  // 不让单次失败掐断后续链路
  pushImageChain = next.then(() => {}, () => {});
  return next;
});
const captureInFlight = new WeakMap();
function capturePageSingleFlight(sender, bounds) {
  const existing = captureInFlight.get(sender);
  if (existing) return existing.result;

  const capture = Promise.resolve().then(() => sender.capturePage(bounds));
  let timeout = null;
  const result = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('capturePage timeout')), 4000);
    capture.then(resolve, reject);
  });
  const state = { capture, result };
  capture.then(() => {
    clearTimeout(timeout);
    if (captureInFlight.get(sender) === state) captureInFlight.delete(sender);
  }, () => {
    clearTimeout(timeout);
    if (captureInFlight.get(sender) === state) captureInFlight.delete(sender);
  });
  captureInFlight.set(sender, state);
  return result;
}
async function captureImageDataUrl(event, rect) {
  const MAX_CAPTURE_PIXELS = 1920 * 1080;
  const bounds = {
    x: Math.max(0, Math.round(Number(rect?.x) || 0)),
    y: Math.max(0, Math.round(Number(rect?.y) || 0)),
    width: Math.min(4096, Math.max(1, Math.round(Number(rect?.width) || 320))),
    height: Math.min(4096, Math.max(1, Math.round(Number(rect?.height) || 240))),
  };
  if (bounds.width * bounds.height > MAX_CAPTURE_PIXELS) {
    throw new Error(`截图区域过大（最大 ${MAX_CAPTURE_PIXELS} 像素）`);
  }
  // A timed-out capturePage keeps running inside Chromium. Keep that actual
  // capture as the sole in-flight operation until it settles, so one timeout
  // cannot start an unbounded series of concurrent captures.
  const image = await capturePageSingleFlight(event.sender, bounds);
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
module.exports = {
  daemonRequest,
  daemonStatus,
  mapSensors,
  listDisks,
  systemInfo,
  __test: {
    isTrustedRendererUrl,
    normalizePlayerConfig,
    playerSupportStatus,
    selectedMediaEntry,
    quotas: {
      total: MEDIA_TOTAL_QUOTA_BYTES,
      entry: MEDIA_ENTRY_QUOTA_BYTES,
      source: MEDIA_SOURCE_MAX_BYTES,
    },
  },
};
