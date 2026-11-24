/* Mini Link — Artistic QR (picture inside the QR code).
   Loaded after qrcode.min.js, before public.js.
   Pure logic + one canvas helper. Works in the browser and in Node
   (module.exports) so the same code is tested with a real decode.
   Exposes window.QrArt = { isProtectedModule, renderArt, drawArtQr }.

   How it stays scannable: the code is built with error correction H
   (30% of modules may be unreadable), the finder / timing / format /
   alignment / version modules are always drawn solid (never covered by
   the picture), and every other module keeps the picture blended under
   its QR colour. The blend slider trades picture visibility against
   scan reliability — higher blend = safer scan. */
'use strict';

(function (global) {
  // Alignment pattern centres per QR version (1 = none), from the QR spec.
  var PATTERN_POS = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
    14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
    17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
    20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98],
    23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106],
    25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114],
    27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
    29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
    31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138],
    33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146],
    35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
    37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162],
    39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
  };

  function versionFromCount(count) {
    return (count - 17) / 4;
  }

  // True when the module at (row, col) must stay solid QR colour:
  // finder patterns + separators, timing row/column, format info,
  // alignment patterns, version info (v7+). Everything else may show
  // the picture blended under its colour.
  function isProtectedModule(r, c, count) {
    // Finder patterns + 1-module separators: 8x8 blocks in 3 corners.
    if (r < 8 && c < 8) return true;
    if (r < 8 && c >= count - 8) return true;
    if (r >= count - 8 && c < 8) return true;
    // Timing patterns: full row 6 and column 6.
    if (r === 6 || c === 6) return true;
    // Format info: full row 8 and column 8.
    if (r === 8 || c === 8) return true;
    // Version info (v7+): 6x3 blocks top-right and bottom-left.
    var v = versionFromCount(count);
    if (v >= 7) {
      if (r < 6 && c >= count - 11) return true;
      if (r >= count - 11 && c < 6) return true;
    }
    // Alignment patterns: 5x5 boxes around each centre (except the
    // three that coincide with the finder patterns).
    var pos = PATTERN_POS[v] || [];
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var cy = pos[i];
        var cx = pos[j];
        if ((cy === 6 && cx === 6) || (cy === 6 && cx === count - 7) || (cy === count - 7 && cx === 6)) continue;
        if (r >= cy - 2 && r <= cy + 2 && c >= cx - 2 && c <= cx + 2) return true;
      }
    }
    return false;
  }

  function hexRgb(hex) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [
      parseInt(h.substr(0, 2), 16),
      parseInt(h.substr(2, 2), 16),
      parseInt(h.substr(4, 2), 16),
    ];
  }

  function clampBlend(b) {
    b = Number(b);
    if (isNaN(b)) return 0.75;
    if (b < 0) return 0;
    if (b > 1) return 1;
    return b;
  }

  // Pure pixel render. qr is a qrcode-generator object (isDark/count);
  // image is { width, height, data } RGBA covering the whole canvas
  // (the caller draws the picture cover-fit first). Returns
  // { width, height, data } RGBA of the finished code.
  // blend 0..1 = QR strength (0 = mostly picture, 1 = mostly QR).
  function renderArt(qr, image, size, blend, fg, bg) {
    blend = clampBlend(blend);
    var fgRgb = hexRgb(fg || '#000000');
    var bgRgb = hexRgb(bg || '#ffffff');
    var count = qr.getModuleCount();
    var quiet = 4;
    var total = count + quiet * 2;
    var scale = size / total;
    var darkA = 0.5 + 0.5 * blend; // dark modules keep at least half their colour
    var lightA = 0.6 * blend; // light modules: white veil over the picture
    var out = new Uint8ClampedArray(size * size * 4);
    var img = image.data;
    var iw = image.width;
    var ih = image.height;
    for (var y = 0; y < size; y++) {
      var my = Math.floor(y / scale) - quiet;
      for (var x = 0; x < size; x++) {
        var mx = Math.floor(x / scale) - quiet;
        var o = (y * size + x) * 4;
        var r;
        var g;
        var b;
        if (mx < 0 || my < 0 || mx >= count || my >= count) {
          // Quiet zone: plain background, always.
          r = bgRgb[0]; g = bgRgb[1]; b = bgRgb[2];
        } else if (isProtectedModule(my, mx, count)) {
          var dark = qr.isDark(my, mx);
          var solid = dark ? fgRgb : bgRgb;
          r = solid[0]; g = solid[1]; b = solid[2];
        } else {
          // Picture pixel (nearest neighbour from the caller's image).
          var ix = Math.min(iw - 1, Math.max(0, Math.floor((x / size) * iw)));
          var iy = Math.min(ih - 1, Math.max(0, Math.floor((y / size) * ih)));
          var io = (iy * iw + ix) * 4;
          var pr = img[io];
          var pg = img[io + 1];
          var pb = img[io + 2];
          if (qr.isDark(my, mx)) {
            r = pr + (fgRgb[0] - pr) * darkA;
            g = pg + (fgRgb[1] - pg) * darkA;
            b = pb + (fgRgb[2] - pb) * darkA;
          } else {
            r = pr + (bgRgb[0] - pr) * lightA;
            g = pg + (bgRgb[1] - pg) * lightA;
            b = pb + (bgRgb[2] - pb) * lightA;
          }
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = 255;
      }
    }
    return { width: size, height: size, data: out };
  }

  // Browser helper: builds the QR (EC level H), draws the picture
  // cover-fit over the code area, blends with renderArt and paints the
  // result onto the canvas. Throws on over-long payloads, like drawQr.
  // opts: { size, blend, fg, bg }. image is a loaded HTMLImageElement.
  function drawArtQr(canvas, payload, image, opts) {
    opts = opts || {};
    var size = opts.size || 512;
    var blend = clampBlend(opts.blend == null ? 0.75 : opts.blend);
    var fg = opts.fg || '#000000';
    var bg = opts.bg || '#ffffff';
    var qr = global.qrcode(0, 'H');
    qr.addData(payload);
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 4;
    var total = count + quiet * 2;
    var scale = size / total;
    // Offscreen canvas: background + picture cover-fit over the code area.
    var off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    var octx = off.getContext('2d');
    octx.fillStyle = bg;
    octx.fillRect(0, 0, size, size);
    var cw = count * scale;
    var cx = quiet * scale;
    var cy = quiet * scale;
    var s = Math.max(cw / image.width, cw / image.height);
    var dw = image.width * s;
    var dh = image.height * s;
    octx.drawImage(image, cx + (cw - dw) / 2, cy + (cw - dh) / 2, dw, dh);
    var imgData = octx.getImageData(0, 0, size, size);
    var art = renderArt(qr, { width: size, height: size, data: imgData.data }, size, blend, fg, bg);
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    var put = ctx.createImageData(size, size);
    put.data.set(art.data);
    ctx.putImageData(put, 0, 0);
  }

  var api = {
    isProtectedModule: isProtectedModule,
    renderArt: renderArt,
    drawArtQr: drawArtQr,
    clampBlend: clampBlend,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.QrArt = api;
})(typeof window !== 'undefined' ? window : globalThis);
