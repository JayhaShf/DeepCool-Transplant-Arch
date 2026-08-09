"use strict";
// Linux stub for node-canvas-skia native binding.
// The real binding only ships Windows/macOS binaries; on Linux we provide a
// no-op Skia backend so the DeepCool main process can boot. Drawing to the
// LCD screen will not render content, but the app UI and device enumeration
// can run.
const ZERO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

class StubContext {
  constructor(canvas) { this._canvas = canvas; }
  clear() {}
  clearRect() {}
  rect() {}
  fillRect() {}
  fill() {}
  setLineDash() {}
  lineCap() {}
  lineJoin() {}
  lineWidth() {}
  stroke() {}
  beginPath() {}
  moveTo() {}
  closePath() {}
  lineTo() {}
  clip() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  arcTo() {}
  isPointInPath() { return false; }
  roundRect() {}
  scale() {}
  rotate() {}
  translate() {}
  transform() {}
  setTransform() {}
  setFont() {}
  setLetterSpacing() {}
  setTextAlign() {}
  setTextBaseline() {}
  fillText() {}
  strokeText() {}
  measureText(text) { return { width: (text ? String(text).length * 8 : 0) }; }
  strokeRect() {}
  setGlobalAlpha() {}
  drawImage() {}
  drawImageWH() {}
  drawImageBuffer() {}
  getFonts() { return []; }
  loadFont() {}
  setShader() {}
  fillStyle() {}
  strokeStyle() {}
}

class StubCanvas {
  constructor(width, height, gpu) {
    this.width = width;
    this.height = height;
    this._ctx = new StubContext(this);
  }
  getContext() { return this._ctx; }
  toBuffer() { return ZERO_PNG; }
  save() {}
  restore() {}
  saveAsImage() {}
}

class StubGradient {
  constructor() {}
  createLinearGradient() {}
  createRadialGradient() {}
  createConicGradient() {}
  addColorStop() {}
}

const binding = {
  SkiaCanvas: StubCanvas,
  SkiaUtils: {
    RGBA: function () { return Array.prototype.join.call(arguments, ','); },
    colorMap: function () { return {}; }
  },
  SkiaGradient: StubGradient
};
binding.default = binding;
module.exports = binding;
