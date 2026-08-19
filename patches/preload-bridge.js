'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { isEventAllowed, isInvokeAllowed } = require('./ipc-policy.js');

const OBSERVED_INVOKE_CHANNELS = new Set([
  'l122/modelConfigurationSearch',
  'l122/modelConfigurationSet',
  'l122/modifyMedia',
  'l122/modifyVideo',
  'l122/playerConfigurationSearch',
  'l122/playerConfigurationSet',
  'l122/setElementDataCurrent',
  'l122/uploadSelectedMedia',
  'l122/uploadSelectedVideo',
]);

let invocationObserver = null;

function denied(channel) {
  return new Error(`IPC channel is not available in the Linux port: ${String(channel)}`);
}

const safeIpcRenderer = {
  async invoke(channel, ...args) {
    if (!isInvokeAllowed(channel)) return Promise.reject(denied(channel));
    const result = await ipcRenderer.invoke(channel, ...args);
    if (invocationObserver && OBSERVED_INVOKE_CHANNELS.has(channel)) {
      try {
        Promise.resolve(invocationObserver(channel, args, result)).catch(() => {});
      } catch (_) {
        // Overlay bookkeeping must never change the official IPC result.
      }
    }
    return result;
  },
  on(channel, listener) {
    if (!isEventAllowed(channel)) throw denied(channel);
    if (typeof listener !== 'function') throw new TypeError('IPC listener must be a function');
    // Keep the official (_event, ...args) callback contract without exposing
    // the privileged Electron event object to the isolated renderer.
    ipcRenderer.on(channel, (_event, ...args) => listener(undefined, ...args));
  },
  removeAllListeners(channel) {
    if (!isEventAllowed(channel)) throw denied(channel);
    ipcRenderer.removeAllListeners(channel);
  },
  observeInvocations(listener) {
    if (typeof listener !== 'function') throw new TypeError('IPC observer must be a function');
    if (invocationObserver) throw new Error('IPC invocation observer is already installed');
    invocationObserver = listener;
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('ipcRenderer', safeIpcRenderer);
  contextBridge.exposeInMainWorld('api', Object.freeze({}));
} else {
  window.ipcRenderer = safeIpcRenderer;
  window.api = Object.freeze({});
}
