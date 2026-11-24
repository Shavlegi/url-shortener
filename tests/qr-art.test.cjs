/* Node tests for Mini Link artistic QR (public/qr-art.js).
   Run:  cd <repo> && npm i --no-save pngjs jsqr && node tests/qr-art.test.cjs
   Covers: protected-module geometry, blend math, and a REAL decode —
   the rendered art QR is encoded to PNG and decoded with jsqr. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const jsqr = require('jsqr');

// The public files use the qr-maker.js UMD pattern (module.exports when
// present, window.QrArt otherwise). This repo's package.json sets
// "type": "module", so plain require() loads them as ESM and the CJS
// branch never runs — load them through a CJS-shaped wrapper instead,
// exactly how the browser's classic <script> path behaves.
function loadCjs(rel) {
  const code = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', 'require', 'globalThis', code)(module, module.exports, require, globalThis);
  return module.exports;
}
const qrcode = loadCjs('../public/qrcode.min.js');
const QrArt = loadCjs('../public/qr-art.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

// --- 1. Protected-module geometry (version 2: count 25) ---------------
ok('finder corners protected (v2)', () => {
  const n = 25;
  for (const [r, c] of [[0, 0], [3, 3], [0, 24], [24, 0], [7, 7], [7, 17], [17, 7]]) {
    assert.equal(QrArt.isProtectedModule(r, c, n), true, r + ',' + c);
  }
  assert.equal(QrArt.isProtectedModule(12, 12, n), false);
  assert.equal(QrArt.isProtectedModule(10, 20, n), false);
});
ok('timing + format rows/cols protected', () => {
  const n = 25;
  assert.equal(QrArt.isProtectedModule(6, 12, n), true);
  assert.equal(QrArt.isProtectedModule(12, 6, n), true);
  assert.equal(QrArt.isProtectedModule(8, 12, n), true);
  assert.equal(QrArt.isProtectedModule(12, 8, n), true);
});
ok('alignment centre protected (v7, count 45)', () => {
  const n = 45; // version 7: positions [6,22,38]
  assert.equal(QrArt.isProtectedModule(22, 22, n), true);
  assert.equal(QrArt.isProtectedModule(22, 38, n), true);
  assert.equal(QrArt.isProtectedModule(38, 22, n), true);
  assert.equal(QrArt.isProtectedModule(38, 38, n), true);
  assert.equal(QrArt.isProtectedModule(20, 20, n), true); // edge of the 5x5 box
  assert.equal(QrArt.isProtectedModule(19, 22, n), false); // just outside
});
ok('version info protected (v7+)', () => {
  const n = 45;
  assert.equal(QrArt.isProtectedModule(2, 40, n), true);
  assert.equal(QrArt.isProtectedModule(40, 2, n), true);
  assert.equal(QrArt.isProtectedModule(2, 30, n), false);
});
ok('clampBlend', () => {
  assert.equal(QrArt.clampBlend(2), 1);
  assert.equal(QrArt.clampBlend(-1), 0);
  assert.equal(QrArt.clampBlend(NaN), 0.75);
  assert.equal(QrArt.clampBlend(0.5), 0.5);
});

// --- 2. Blend math -------------------------------------------------------
function flatImage(size, r, g, b) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}
ok('renderArt: size + quiet zone + protected solid', () => {
  const qr = qrcode(0, 'H');
  qr.addData('https://minilink.space/test');
  qr.make();
  const size = 200;
  const img = flatImage(size, 200, 30, 30); // dark red picture
  const out = QrArt.renderArt(qr, img, size, 0.75, '#000000', '#ffffff');
  assert.equal(out.width, size);
  assert.equal(out.data.length, size * size * 4);
  // Quiet zone (top-left corner pixel) is plain white.
  assert.deepEqual([out.data[0], out.data[1], out.data[2], out.data[3]], [255, 255, 255, 255]);
  // A protected dark finder module is solid black: module (3,3) centre.
  const count = qr.getModuleCount();
  const scale = size / (count + 8);
  const px = Math.floor((3 + 4) * scale + scale / 2);
  const py = Math.floor((3 + 4) * scale + scale / 2);
  const o = (py * size + px) * 4;
  assert.deepEqual([out.data[o], out.data[o + 1], out.data[o + 2]], [0, 0, 0]);
});

// --- 3. Real decode: art QR must scan ------------------------------------
function busyImage(size, seed) {
  // Deterministic busy "photo": gradient + coloured blocks.
  const data = new Uint8ClampedArray(size * size * 4);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const blocks = [];
  for (let i = 0; i < 40; i++) {
    blocks.push({ x: rnd() * size, y: rnd() * size, w: 30 + rnd() * 120, h: 30 + rnd() * 120,
      r: Math.floor(rnd() * 256), g: Math.floor(rnd() * 256), b: Math.floor(rnd() * 256) });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      let r = Math.floor((x / size) * 255);
      let g = Math.floor((y / size) * 200);
      let b = Math.floor(255 - (x / size) * 255);
      for (const bl of blocks) {
        if (x >= bl.x && x < bl.x + bl.w && y >= bl.y && y < bl.y + bl.h) { r = bl.r; g = bl.g; b = bl.b; }
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

function decodeArt(payload, image, blend) {
  const qr = qrcode(0, 'H');
  qr.addData(payload);
  qr.make();
  const size = 512;
  const art = QrArt.renderArt(qr, image, size, blend, '#000000', '#ffffff');
  const png = new PNG({ width: size, height: size });
  png.data = Buffer.from(art.data);
  const buf = PNG.sync.write(png);
  const back = PNG.sync.read(buf);
  const res = jsqr(new Uint8ClampedArray(back.data), back.width, back.height, { inversionAttempts: 'attemptBoth' });
  return res ? res.data : null;
}

const cases = [
  ['https://minilink.space/abc123', 'short link'],
  ['https://instagram.com/shao42ia', 'instagram link'],
  ['WIFI:T:WPA;S:Cafe-WiFi;P:secret123;;', 'wifi payload'],
  ['https://example.com/a-very-long-path/with-many-segments/and-a-query?x=1&y=2&z=3', 'long link'],
];
for (const [payload, label] of cases) {
  for (const blend of [1.0, 0.75, 0.5]) {
    const got = decodeArt(payload, busyImage(512, 42), blend);
    assert.equal(got, payload, label + ' blend=' + blend + ' decoded as ' + got);
    passed++;
    console.log('ok - decode ' + label + ' blend=' + blend);
  }
}
// Dark picture is the hard case: dark modules over a dark image.
ok('decode with dark picture (blend 0.75)', () => {
  const got = decodeArt('https://minilink.space/abc123', flatImage(512, 20, 20, 40), 0.75);
  assert.equal(got, 'https://minilink.space/abc123');
});

console.log('\n' + passed + ' checks passed');
