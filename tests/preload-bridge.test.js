'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'patches', 'preload-bridge.js'), 'utf8');
const policy = require('../patches/ipc-policy.js');

function loadBridge() {
  const exposed = {};
  const calls = [];
  const eventListeners = new Map();
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = Object.freeze(value);
      },
    },
    ipcRenderer: {
      async invoke(channel, ...args) {
        calls.push([channel, ...args]);
        return { code: 0, data: { channel } };
      },
      on(channel, listener) { eventListeners.set(channel, listener); },
      removeAllListeners() {},
    },
  };
  const sandbox = {
    module: { exports: {} },
    exports: {},
    process: { contextIsolated: true },
    require(id) {
      if (id === 'electron') return electron;
      if (id === './ipc-policy.js') return policy;
      throw new Error(`unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'preload-bridge.js' });
  return { api: exposed.ipcRenderer, calls, eventListeners };
}

test('preload exposes a frozen allowlisted IPC bridge', async () => {
  const { api, calls } = loadBridge();
  assert.equal(Object.isFrozen(api), true);
  await assert.rejects(api.invoke('sys/restart-system'), /not available/);
  assert.deepEqual(calls, []);

  const result = await api.invoke('linux/status');
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [['linux/status']]);
});

test('preload observes only the L122 calls needed by the overlay', async () => {
  const { api } = loadBridge();
  const observed = [];
  api.observeInvocations((channel, args, result) => {
    observed.push({ channel, args: Array.from(args), result });
  });

  await api.invoke('linux/status');
  await api.invoke('l122/modelConfigurationSet', { modeChange: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(observed.length, 1);
  assert.equal(observed[0].channel, 'l122/modelConfigurationSet');
  assert.deepEqual(observed[0].args, [{ modeChange: 1 }]);
  assert.equal(observed[0].result.code, 0);
  assert.throws(() => api.observeInvocations(() => {}), /already installed/);
});

test('preload event bridge does not expose the privileged Electron event', () => {
  const { api, eventListeners } = loadBridge();
  let received;
  api.on('worker/ready', (...args) => { received = args; });
  const privilegedEvent = { sender: { id: 99 } };
  eventListeners.get('worker/ready')(privilegedEvent, 'payload', 7);
  assert.deepEqual(received, [undefined, 'payload', 7]);
});
