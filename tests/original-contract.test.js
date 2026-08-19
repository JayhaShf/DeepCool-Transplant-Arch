'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const renderer = path.join(
  __dirname,
  '..',
  'work/windows-app/resources/app.asar.extracted/out/renderer/assets/index-8dc9d6df.js',
);
const rendererApi = path.join(
  __dirname,
  '..',
  'work/windows-app/resources/app.asar.extracted/out/renderer/assets/index-c58f7fdf.js',
);
const overlay = path.join(__dirname, '..', 'patches', 'linux-overlay.js');
const compat = path.join(__dirname, '..', 'patches', 'linux-compat.js');
const daemon = path.join(__dirname, '..', 'daemon', 'deepcool-lm-daemon.py');

test('Linux overlay embeds the exact official L122 status icons', () => {
  const source = fs.readFileSync(overlay, 'utf8');
  assert.doesNotMatch(source, /'''\+icons\[/);
  for (const name of ['cpu_icon', 'gpu_icon', 'ram_icon']) {
    assert.match(source, new RegExp(`${name}:\\s*["']data:image/png;base64,`), name);
  }
});

test('extracted DeepCool 1.2.12 renderer contract matches the compatibility target', (t) => {
  if (!fs.existsSync(renderer)) {
    t.skip('official payload has not been extracted');
    return;
  }

  const source = fs.readFileSync(renderer, 'utf8');
  const apiSource = fs.readFileSync(rendererApi, 'utf8');
  assert.match(source, /setCurrentMedia\(\[element\]\)/);
  assert.match(source, /playingOrder:\s*"loop"/);
  assert.match(source, /playingAnimation:\s*"panning"/);
  assert.match(source, /label:\s*"static"/);
  assert.match(source, /label:\s*"ease_in_out"/);
  assert.match(apiSource, /ipcInstance\.send\("l122\/setElementDataCurrent", serialNumber, value\)/);
});

test('main and daemon agree on bounded image delivery confirmation', () => {
  const compatSource = fs.readFileSync(compat, 'utf8');
  const daemonSource = fs.readFileSync(daemon, 'utf8');
  assert.match(compatSource, /confirm_timeout_ms:\s*2000/);
  const limit = daemonSource.match(/MAX_CONFIRM_TIMEOUT_MS\s*=\s*(\d+)/);
  assert.ok(limit, 'daemon confirmation timeout constant is present');
  assert.equal(Number(limit[1]), 2000);
});
