'use strict';
// Linux stub for system_info_x64.node (Windows native). Provides real disk
// data (from `df -Pk`) so the app's storage panel shows real capacity; all
// other calls return the permissive magic value.
//
// The real Windows DLL returns total/free in BYTES; the main process converts
// to whole GB with ceil(bytes/1073741824) before handing them to the renderer,
// so we must also return bytes here.
const fs = require('fs');
const { execFileSync } = require('child_process');

function makeMagic(name) {
  const fn = function MagicStub() {};
  const p = new Proxy(fn, {
    apply() { return p; },
    construct() { return p; },
    get(target, prop, receiver) {
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
    set() { return true; },
    has() { return true; },
    ownKeys() { return []; },
    getOwnPropertyDescriptor() { return { configurable: true, enumerable: false, writable: true, value: p }; }
  });
  return p;
}

function listDisks() {
  const out = [];
  const seen = new Set();
  try {
    // -- device -> mountpoint map from /proc/mounts
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n')
      .map((l) => l.split(' '))
      .filter((a) => a.length >= 2 && a[0].startsWith('/dev/'));
    for (const [dev, mnt] of mounts) {
      const name = dev.replace('/dev/', '');
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        // df -Pk: total KB, used KB, available KB, capacity, mountpoint
        // timeout 防止挂死的挂载点（NFS/网络盘）冻结主进程
        const line = execFileSync('df', ['-Pk', '--', mnt], { encoding: 'utf8', timeout: 2500 })
          .split('\n')[1].split(/\s+/);
        const total = parseInt(line[1], 10) * 1024;
        const used = parseInt(line[2], 10) * 1024;
        const free = parseInt(line[3], 10) * 1024;
        const usedRate = total > 0 ? Math.round((used / total) * 100) : 0;
        out.push({
          name, diskName: name, Disk: name,
          size: total, totalSize: total, Size: total,
          used, freeSize: free, FreeSize: free,
          usedRate, total, free, diskIndex: out.length, index: out.length
        });
      } catch (e) {}
    }
  } catch (e) {}
  if (!out.length) {
    // Container/VM without real block mounts: return a plausible 500 GB disk
    const total = 500 * 1024 * 1024 * 1024;
    const free = 250 * 1024 * 1024 * 1024;
    out.push({ name: '/dev/sda', diskName: '/dev/sda', Disk: '/dev/sda', size: total, totalSize: total, Size: total, used: free, freeSize: free, FreeSize: free, usedRate: 50, total, free, diskIndex: 0, index: 0 });
  }
  return out;
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
