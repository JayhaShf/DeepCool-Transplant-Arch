'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isEventAllowed, isInvokeAllowed } = require('../patches/ipc-policy.js');

test('allows the original LM-Series and Linux compatibility channels', () => {
  for (const channel of [
    'app/get-sensors-data',
    'app/get-setting',
    'app/set-setting',
    'l122/getAllMedia',
    'l122/modelConfigurationSet',
    'media/selectImg',
    'linux/capture-image',
    'linux/media-playback',
    'linux/push-image',
    'sys/close-window',
  ]) {
    assert.equal(isInvokeAllowed(channel), true, channel);
  }
});

test('blocks update, reboot, and unrelated device-control channels', () => {
  for (const channel of [
    'app/update-firmware',
    'app/update-software',
    'app/update-sw-fw',
    'sys/restart-system',
    'ak/update-device-info',
    'l086/modelConfigurationSet',
    '../linux/status',
    'linux/capture-arbitrary',
    '',
  ]) {
    assert.equal(isInvokeAllowed(channel), false, channel);
  }
  assert.equal(isInvokeAllowed(null), false);
});

test('allows only renderer events used by the original application', () => {
  assert.equal(isEventAllowed('worker/ready'), true);
  assert.equal(isEventAllowed('usb-change'), true);
  assert.equal(isEventAllowed('app/progress'), true);
  assert.equal(isEventAllowed('worker/arbitrary'), false);
  assert.equal(isEventAllowed('linux/status'), false);
});
