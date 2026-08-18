'use strict';

const INVOKE_CHANNELS = new Set([
  'app/check-fw-update',
  'app/check-sw-fw-update',
  'app/get-co-branding',
  'app/get-device-list',
  'app/get-disk-list',
  'app/get-fan-interface',
  'app/get-sensors-data',
  'app/get-setting',
  'app/get-systeminfo',
  'app/set-default-gpu',
  'app/set-setting',
  'l122/deleteOneMedia',
  'l122/getAllMedia',
  'l122/getElementDataCurrent',
  'l122/image-transmission',
  'l122/modelConfigurationSearch',
  'l122/modelConfigurationSet',
  'l122/modifyMedia',
  'l122/modifyVideo',
  'l122/playerConfigurationSearch',
  'l122/playerConfigurationSet',
  'l122/setElementDataCurrent',
  'l122/uploadSelectedMedia',
  'l122/uploadSelectedVideo',
  'media/getSpecialMediaInfo',
  'media/selectGif',
  'media/selectImg',
  'media/selectVideo',
  'sys/check-media-components',
  'sys/close-window',
  'sys/exit',
  'sys/get-resources',
  'sys/maximize-window',
  'sys/minimize-window',
  'sys/select-image',
  'sys/unmaximize-window',
  'worker/clear-sdk-history',
  'worker/get-sdk-history',
  'linux/autostart-set',
  'linux/autostart-status',
  'linux/capture-image',
  'linux/capture-preview',
  'linux/daemon-command',
  'linux/hold-state',
  'linux/media-playback',
  'linux/preset-load',
  'linux/preset-save',
  'linux/push-image',
  'linux/status',
  'linux/windows',
]);

const EVENT_CHANNELS = new Set([
  'app/download-progress',
  'app/progress',
  'usb-change',
  'window-change',
  'worker/pic-change',
  'worker/ready',
  'worker/rotate-change',
  'worker/rotate-focus-change',
]);

function isInvokeAllowed(channel) {
  return typeof channel === 'string' && INVOKE_CHANNELS.has(channel);
}

function isEventAllowed(channel) {
  return typeof channel === 'string' && EVENT_CHANNELS.has(channel);
}

module.exports = { isInvokeAllowed, isEventAllowed };
