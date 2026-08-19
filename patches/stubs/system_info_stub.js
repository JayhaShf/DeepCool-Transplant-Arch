'use strict';
// Linux stub for system_info_x64.node (Windows native). Provides real disk
// data (from `df -Pk`) so the app's storage panel shows real capacity; all
// other calls return the permissive magic value.
//
// The real Windows DLL returns total/free in BYTES; the main process converts
// to whole GB with ceil(bytes/1073741824) before handing them to the renderer,
// so we must also return bytes here.
const { execFileSync } = require('child_process');

function makeMagic(name) {
  const fn = function MagicStub() {};
  const p = new Proxy(fn, {
    apply() { return p; },
    construct() { return p; },
    get(target, prop, receiver) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
        return descriptor.value;
      }
      if (prop === 'then') {
        // 同 controller_stub：resolve 值不能是 p（thenable 自我收养挂起），
        // 同步 resolve(undefined)，与 Windows 桩行为一致。
        return function (onFulfilled) {
          if (typeof onFulfilled === 'function') onFulfilled();
          return 0;
        };
      }
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.for('nodejs.util.inspect.custom')) return () => '[DeepCool linux stub]';
      return p;
    },
    set(target, prop, value) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) {
        return Object.is(descriptor.value, value);
      }
      return true;
    },
    has() { return true; },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop)
        || { configurable: true, enumerable: false, writable: true, value: p };
    }
  });
  return p;
}

let diskCache = null;
let diskCacheAt = 0;
function listDisks() {
  if (diskCache && Date.now() - diskCacheAt < 5000) {
    return diskCache.map((disk) => ({ ...disk }));
  }
  const out = [];
  const seen = new Set();
  try {
    // One cached local-filesystem query replaces the old per-mount df loop,
    // which could block the main process for 2.5 seconds per mount.
    const lines = execFileSync('df', ['-Pkl'], { encoding: 'utf8', timeout: 2500 })
      .split('\n').slice(1);
    for (const row of lines) {
      const line = row.trim().split(/\s+/);
      const dev = line[0];
      if (!dev || !dev.startsWith('/dev/') || line.length < 6) continue;
      const name = dev.replace('/dev/', '');
      if (seen.has(name)) continue;
      seen.add(name);
      const total = parseInt(line[1], 10) * 1024;
      const used = parseInt(line[2], 10) * 1024;
      const free = parseInt(line[3], 10) * 1024;
      if (![total, used, free].every(Number.isFinite)) continue;
      const usedRate = total > 0 ? Math.round((used / total) * 100) : 0;
      out.push({
        name, diskName: name, Disk: name,
        size: total, totalSize: total, Size: total,
        used, freeSize: free, FreeSize: free,
        usedRate, total, free, diskIndex: out.length, index: out.length
      });
    }
  } catch (e) {}
  if (!out.length) {
    // Overlay/container roots may not appear as /dev mounts.  If so, query
    // the real root filesystem rather than inventing capacity values.
    try {
      const line = execFileSync('df', ['-Pkl', '--', '/'], { encoding: 'utf8', timeout: 2500 })
        .split('\n').slice(1).map((row) => row.trim()).find(Boolean)?.split(/\s+/);
      const dev = line?.[0] || '/';
      const total = parseInt(line?.[1], 10) * 1024;
      const used = parseInt(line?.[2], 10) * 1024;
      const free = parseInt(line?.[3], 10) * 1024;
      if ([total, used, free].every(Number.isFinite) && total > 0) {
        const usedRate = Math.round((used / total) * 100);
        out.push({
          name: dev, diskName: dev, Disk: dev,
          size: total, totalSize: total, Size: total,
          used, freeSize: free, FreeSize: free,
          usedRate, total, free, diskIndex: 0, index: 0,
        });
      }
    } catch (_) {}
  }
  diskCache = out;
  diskCacheAt = Date.now();
  return out.map((disk) => ({ ...disk }));
}

const magic = makeMagic('system_info');
const exportsObj = new Proxy(magic, {
  get(target, prop, receiver) {
    if (prop === 'getDiskFreeInfo' || prop === 'getDiskInfo') {
      return function () { return JSON.stringify(listDisks()); };
    }
    if (prop === 'then') return undefined; // module itself should not be thenable
    return Reflect.get(target, prop, receiver);
  }
});
module.exports = exportsObj;
