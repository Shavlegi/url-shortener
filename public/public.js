/* Mini Link — public shorten form (vanilla JS, no framework).
   No login: anyone can shorten a link. Abuse limits live server-side
   (POST /api/public/shorten: 3/min + 10/hour per hashed IP, auto alias
   only). Moderation happens in the admin dashboard. */
'use strict';

const $ = (id) => document.getElementById(id);

const toastEl = $('toast');

let toastTimer = null;
let currentQrLink = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}
function hideError(el) {
  el.hidden = true;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

/* v7.2: single lilac-black theme for everyone — the theme picker was
   removed. Drop any stale saved theme so old devices get the one theme. */
try {
  localStorage.removeItem('minilink-theme');
  document.body.classList.remove('theme-black', 'theme-blue', 'theme-white');
} catch { /* ignore */ }

/* ---------------- Share buttons ---------------- */
// One-tap share of a short link: WhatsApp / Telegram / Facebook open in
// a new tab; the native "გაზიარება" button opens the phone's share sheet
// (only shown where navigator.share exists). Shared with auth.js.
function shareButtons(link) {
  const wrap = document.createElement('div');
  wrap.className = 'link-actions';
  const u = encodeURIComponent(link.shortUrl);
  const mk = (label, href) => {
    const a = document.createElement('a');
    a.className = 'btn small';
    a.textContent = label;
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    wrap.appendChild(a);
  };
  mk('WhatsApp', 'https://wa.me/?text=' + u);
  mk('Telegram', 'https://t.me/share/url?url=' + u + '&text=' + encodeURIComponent('Mini Link'));
  mk('Facebook', 'https://www.facebook.com/sharer/sharer.php?u=' + u);
  if (typeof navigator !== 'undefined' && navigator.share) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'გაზიარება';
    b.addEventListener('click', async () => {
      try {
        await navigator.share({ title: 'Mini Link', text: link.shortUrl, url: link.shortUrl });
      } catch (e) {
        if (e && e.name !== 'AbortError') toast('გაზიარება ვერ მოხერხდა');
      }
    });
    wrap.appendChild(b);
  }
  return wrap;
}

/* ---------------- Turnstile (bot check, public form only) ------------- */
// Renders only when a site key is configured (window.MINILINK_TURNSTILE_SITEKEY,
// set by the inline script in index.html; empty = Turnstile off, the form
// works exactly as before). The token is sent with the shorten request;
// the server verifies it only when TURNSTILE_SECRET_KEY is set.
let turnstileToken = null;
let turnstileWidgetId = null;

function loadTurnstile() {
  const sitekey = window.MINILINK_TURNSTILE_SITEKEY || '';
  if (!sitekey) return;
  const host = $('turnstile-widget');
  if (!host) return;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    try {
      turnstileWidgetId = window.turnstile.render(host, {
        sitekey,
        callback: (token) => { turnstileToken = token; },
        'expired-callback': () => {
          turnstileToken = null;
          if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
        },
      });
    } catch { /* widget failed to render — the form still works */ }
  };
  document.head.appendChild(script);
}

loadTurnstile();

/* ---------------- Shorten ---------------- */

$('shorten-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('shorten-btn');
  const err = $('shorten-error');
  const result = $('shorten-result');
  hideError(err);
  result.hidden = true;
  btn.disabled = true;

  try {
    const body = { destination: $('dest-input').value.trim() };
    const note = $('public-note-input').value.trim();
    if (note) body.note = note;
    if (turnstileToken) body.turnstileToken = turnstileToken;
    const res = await fetch('/api/public/shorten', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      throw new Error((data && data.error) || ('შეცდომა: ' + res.status));
    }
    const link = data.link;
    const a = $('result-link');
    a.href = link.shortUrl;
    a.textContent = link.shortUrl;
    result.hidden = false;
    $('result-copy').onclick = async () => {
      if (await copyText(link.shortUrl)) toast('მოკლე ბმული დაკოპირდა');
      else toast('კოპირება ვერ მოხერხდა');
    };
    $('result-qr').onclick = () => openQr(link);
    const shareHost = $('result-share');
    shareHost.innerHTML = '';
    shareHost.appendChild(shareButtons(link));
    $('dest-input').value = '';
    $('public-note-input').value = '';
    toast('ბმული შეიქმნა');
  } catch (e2) {
    showError(err, e2.message || 'ბმულის შექმნა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- QR ---------------- */

function drawQr(canvas, text, size, opts) {
  // qrcode-generator (vendored in qrcode.min.js): 0 = auto type number.
  // opts: { fg, bg, logo } — logo is a loaded Image; with a logo the
  // error-correction level rises to Q so the centre overlay stays scannable.
  opts = opts || {};
  const fg = opts.fg || '#000000';
  const bg = opts.bg || '#ffffff';
  const qr = qrcode(0, opts.logo ? 'Q' : 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4; // quiet zone, in modules (required for reliable scanning)
  const total = count + quiet * 2;
  const scale = size / total;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = fg;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(
          Math.floor((c + quiet) * scale),
          Math.floor((r + quiet) * scale),
          Math.ceil(scale) + 0.5,
          Math.ceil(scale) + 0.5,
        );
      }
    }
  }
  if (opts.logo) {
    // Centre logo: white plate (~22% of the code) so dark modules never
    // touch the image, then the image fitted inside it.
    const plate = size * 0.22;
    const x = (size - plate) / 2;
    const y = (size - plate) / 2;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, plate, plate);
    const pad = plate * 0.08;
    ctx.drawImage(opts.logo, x + pad, y + pad, plate - pad * 2, plate - pad * 2);
  }
}

function openQr(link) {
  currentQrLink = link;
  $('qr-title').textContent = 'QR კოდი — ' + link.alias;
  $('qr-url').textContent = link.shortUrl;
  try {
    drawQr($('qr-canvas'), link.shortUrl, 256);
  } catch (e) {
    toast('QR კოდის შექმნა ვერ მოხერხდა: ბმული ძალიან გრძელია');
    return;
  }
  $('qr-modal').hidden = false;
}

$('qr-close').addEventListener('click', () => { $('qr-modal').hidden = true; });
$('qr-modal').addEventListener('click', (e) => {
  if (e.target === $('qr-modal')) $('qr-modal').hidden = true;
});

$('qr-download').addEventListener('click', () => {
  if (!currentQrLink) return;
  const canvas = $('qr-canvas');
  canvas.toBlob((blob) => {
    if (!blob) { toast('PNG შენახვა ვერ მოხერხდა'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentQrLink.alias + '-qr.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('QR კოდი გადმოიწერა');
  }, 'image/png');
});

/* ---------------- QR Maker (v5) ---------------- */
// Standalone QR codes for anything — link, Instagram, Wi-Fi, phone,
// text, Google review. Everything renders on-device (qrcode-generator);
// nothing is sent to the server except a favorite the user saves while
// logged in (POST /api/auth/qr-favorites). Anonymous favorites live in
// localStorage on this device only.
const QR_TYPE_NAMES = {
  link: 'ბმული',
  instagram: 'Instagram',
  wifi: 'Wi-Fi',
  phone: 'ტელეფონი',
  text: 'ტექსტი',
  review: 'Google შეფასება',
};
const QR_FAV_LOCAL_KEY = 'minilink-qr-favorites';
const QR_FAV_LOCAL_MAX = 50;

let makerType = 'link';
let makerLogoImg = null;
let makerCurrent = null; // { type, label, payload, fg, bg }

function makerLoggedIn() {
  return typeof window.isUserLoggedIn === 'function' && window.isUserLoggedIn();
}

function makerFieldsHtml(type) {
  if (type === 'link') {
    return '<label class="field"><span>ბმული</span>' +
      '<input id="qr-url-input" type="url" inputmode="url" placeholder="https://example.com" autocomplete="off"></label>';
  }
  if (type === 'instagram') {
    return '<label class="field"><span>Instagram მომხმარებელი ან ბმული</span>' +
      '<input id="qr-handle-input" type="text" placeholder="@username ან https://instagram.com/username" autocomplete="off"></label>';
  }
  if (type === 'wifi') {
    return '<label class="field"><span>Wi-Fi სახელი (SSID)</span>' +
      '<input id="qr-ssid-input" type="text" placeholder="მაგ. Cafe-WiFi" autocomplete="off"></label>' +
      '<label class="field"><span>დაცვა</span>' +
      '<select id="qr-wifi-enc"><option value="WPA">WPA / WPA2</option><option value="WEP">WEP</option><option value="nopass">ღია — პაროლის გარეშე</option></select></label>' +
      '<label class="field"><span>Wi-Fi პაროლი</span>' +
      '<input id="qr-wifi-pass-input" type="text" placeholder="პაროლი" autocomplete="off"></label>';
  }
  if (type === 'phone') {
    return '<label class="field"><span>ტელეფონის ნომერი</span>' +
      '<input id="qr-phone-input" type="tel" inputmode="tel" placeholder="+995 5XX XX XX XX" autocomplete="off"></label>';
  }
  if (type === 'text') {
    return '<label class="field"><span>ტექსტი</span>' +
      '<textarea id="qr-text-input" rows="3" maxlength="2048" placeholder="ნებისმიერი ტექსტი — მაქს. 2048 სიმბოლო"></textarea></label>';
  }
  // review
  return '<label class="field"><span>Google შეფასების ბმული</span>' +
    '<input id="qr-url-input" type="url" inputmode="url" placeholder="https://g.page/r/… ან https://search.google.com/local/reviews?…" autocomplete="off"></label>' +
    '<p class="muted">ბმულს Google Maps-ზე თქვენი ბიზნესის გვერდიდან „გაზიარება" ღილაკით აიღებთ.</p>';
}

function setMakerType(type) {
  if (!QR_TYPE_NAMES[type]) type = 'link';
  makerType = type;
  document.querySelectorAll('#qr-type-tabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-qr-type') === type);
  });
  $('qr-type-fields').innerHTML = makerFieldsHtml(type);
  const enc = $('qr-wifi-enc');
  if (enc) {
    const syncPass = () => {
      const pass = $('qr-wifi-pass-input');
      if (pass) pass.disabled = enc.value === 'nopass';
    };
    enc.addEventListener('change', syncPass);
    syncPass();
  }
  hideError($('qr-maker-error'));
}

document.querySelectorAll('#qr-type-tabs .tab-btn').forEach((b) => {
  b.addEventListener('click', () => setMakerType(b.getAttribute('data-qr-type')));
});
setMakerType('link');

// Optional centre logo: loaded from the user's file, drawn on the QR
// (white plate, ~22% of the code). Only images from the user's device.
$('qr-logo-input').addEventListener('change', () => {
  const file = $('qr-logo-input').files && $('qr-logo-input').files[0];
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) {
    toast('აირჩიეთ სურათის ფაილი');
    $('qr-logo-input').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      makerLogoImg = img;
      $('qr-logo-name').textContent = 'ლოგო: ' + file.name;
      $('qr-logo-clear').hidden = false;
      if (makerCurrent) renderMakerQr();
    };
    img.onerror = () => toast('ლოგოს ჩატვირთვა ვერ მოხერხდა');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});
$('qr-logo-clear').addEventListener('click', () => {
  makerLogoImg = null;
  $('qr-logo-input').value = '';
  $('qr-logo-name').textContent = '';
  $('qr-logo-clear').hidden = true;
  if (makerCurrent) renderMakerQr();
});

function makerFieldValues() {
  if (makerType === 'link' || makerType === 'review') return { url: $('qr-url-input').value };
  if (makerType === 'instagram') return { handle: $('qr-handle-input').value };
  if (makerType === 'wifi') {
    return {
      ssid: $('qr-ssid-input').value,
      enc: $('qr-wifi-enc').value,
      password: $('qr-wifi-pass-input').value,
    };
  }
  if (makerType === 'phone') return { phone: $('qr-phone-input').value };
  return { text: $('qr-text-input').value };
}

function makerDefaultLabel(type, payload) {
  const short = payload.length > 28 ? payload.slice(0, 28) + '…' : payload;
  return QR_TYPE_NAMES[type] + ' — ' + short;
}

function renderMakerQr() {
  if (!makerCurrent) return;
  try {
    // Rendered at 512px for a sharp PNG; CSS shows it at 256px.
    drawQr($('qr-maker-canvas'), makerCurrent.payload, 512, {
      fg: makerCurrent.fg,
      bg: makerCurrent.bg,
      logo: makerLogoImg || undefined,
    });
  } catch (e) {
    showError($('qr-maker-error'), 'QR კოდის შექმნა ვერ მოხერხდა: შიგთავსი ძალიან გრძელია');
    $('qr-maker-result').hidden = true;
    makerCurrent = null;
    return;
  }
  $('qr-maker-payload').textContent = makerCurrent.payload;
  $('qr-maker-result').hidden = false;
}

$('qr-make-btn').addEventListener('click', () => {
  const err = $('qr-maker-error');
  hideError(err);
  const built = window.QrMaker.buildQrPayload(makerType, makerFieldValues());
  if (!built.ok) {
    showError(err, built.reason);
    return;
  }
  makerCurrent = {
    type: makerType,
    label: $('qr-label-input').value.trim() || makerDefaultLabel(makerType, built.payload),
    payload: built.payload,
    fg: $('qr-fg-input').value || '#000000',
    bg: $('qr-bg-input').value || '#ffffff',
  };
  renderMakerQr();
  // v6: every generated QR is also logged server-side (fire-and-forget)
  // so the admin sees everything, like links. The QR renders even if
  // logging fails; nothing here waits on the network.
  if (makerCurrent) logQrGeneration(makerCurrent);
});

// v6: log one generation to POST /api/qr-log. Logged-in users get their
// user_id attached server-side; anonymous rows stay ownerless. Best-effort.
async function logQrGeneration(fav) {
  try {
    await fetch('/api/qr-log', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: fav.type,
        label: fav.label,
        payload: fav.payload,
        fg: fav.fg,
        bg: fav.bg,
      }),
    });
  } catch { /* logging is best-effort */ }
}

// Re-render live when colors change (only if a code is already shown).
$('qr-fg-input').addEventListener('input', () => {
  if (!makerCurrent) return;
  makerCurrent.fg = $('qr-fg-input').value;
  renderMakerQr();
});
$('qr-bg-input').addEventListener('input', () => {
  if (!makerCurrent) return;
  makerCurrent.bg = $('qr-bg-input').value;
  renderMakerQr();
});

/* Custom color picker modal (v8.4): the "მორგებული" button opens this
   directly — Hue/Saturation/Value sliders like the phone picker's Custom
   view. The native picker can't be forced into its Custom view, so the
   site has its own. Draft until Set; Cancel discards. Sequential: QR
   color first, then background. */
function qrHexToHsv(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substr(0, 2), 16) / 255;
  const g = parseInt(c.substr(2, 2), 16) / 255;
  const b = parseInt(c.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(max * 100) };
}
function qrHsvToHex(h, s, v) {
  s /= 100; v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
let qrColorTarget = null; // 'qr-fg-input' | 'qr-bg-input'
let qrColorChainBg = false;
function qrColorModalRefresh() {
  const h = Number($('qr-hue-slider').value);
  const s = Number($('qr-sat-slider').value);
  const v = Number($('qr-val-slider').value);
  const hex = qrHsvToHex(h, s, v);
  $('qr-chosen-swatch').style.background = hex;
  $('qr-chosen-hex').textContent = hex.toUpperCase();
  // Slider tracks follow the current hue/saturation/value.
  $('qr-sat-slider').style.background =
    'linear-gradient(90deg, ' + qrHsvToHex(h, 0, v) + ', ' + qrHsvToHex(h, 100, v) + ')';
  $('qr-val-slider').style.background =
    'linear-gradient(90deg, #000000, ' + qrHsvToHex(h, s, 100) + ')';
}
function qrColorModalOpen(targetId, title, chainBg) {
  qrColorTarget = targetId;
  qrColorChainBg = chainBg;
  $('qr-color-modal-title').textContent = title;
  const hsv = qrHexToHsv($(targetId).value || '#000000');
  $('qr-hue-slider').value = hsv.h;
  $('qr-sat-slider').value = hsv.s;
  $('qr-val-slider').value = hsv.v;
  qrColorModalRefresh();
  $('qr-color-modal').hidden = false;
}
function qrColorModalClose() {
  $('qr-color-modal').hidden = true;
  qrColorTarget = null;
  qrColorChainBg = false;
}
['qr-hue-slider', 'qr-sat-slider', 'qr-val-slider'].forEach((id) => {
  $(id).addEventListener('input', qrColorModalRefresh);
});
$('qr-color-cancel').addEventListener('click', qrColorModalClose);
$('qr-color-modal').addEventListener('click', (e) => {
  if (e.target === $('qr-color-modal')) qrColorModalClose();
});
$('qr-color-set').addEventListener('click', () => {
  const h = Number($('qr-hue-slider').value);
  const s = Number($('qr-sat-slider').value);
  const v = Number($('qr-val-slider').value);
  const hex = qrHsvToHex(h, s, v);
  const target = $(qrColorTarget);
  target.value = hex;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  if (qrColorChainBg && qrColorTarget === 'qr-fg-input') {
    qrColorModalOpen('qr-bg-input', 'ფონი', false);
  } else {
    qrColorModalClose();
  }
});
/* Prepared colors modal (v8.7): the QR color / background buttons open this
   glass modal with 8 ready colors only — no Custom link. Draft until Set. */
let qrPresetTarget = null;
let qrPresetSelected = '#000000';
function qrPresetModalRefresh() {
  document.querySelectorAll('.qr-preset-sq').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.color.toLowerCase() === qrPresetSelected.toLowerCase());
  });
  $('qr-preset-chosen-swatch').style.background = qrPresetSelected;
  $('qr-preset-chosen-hex').textContent = qrPresetSelected.toUpperCase();
}
function qrPresetModalOpen(targetId, title) {
  qrPresetTarget = targetId;
  qrPresetSelected = $(targetId).value || '#000000';
  $('qr-preset-modal-title').textContent = title;
  qrPresetModalRefresh();
  $('qr-preset-modal').hidden = false;
}
function qrPresetModalClose() {
  $('qr-preset-modal').hidden = true;
  qrPresetTarget = null;
}
document.querySelectorAll('.qr-preset-sq').forEach((btn) => {
  btn.addEventListener('click', () => {
    qrPresetSelected = btn.dataset.color;
    qrPresetModalRefresh();
  });
});
$('qr-preset-cancel').addEventListener('click', qrPresetModalClose);
$('qr-preset-modal').addEventListener('click', (e) => {
  if (e.target === $('qr-preset-modal')) qrPresetModalClose();
});
$('qr-preset-set').addEventListener('click', () => {
  const target = $(qrPresetTarget);
  target.value = qrPresetSelected;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  qrPresetModalClose();
});

/* Button swatches mirror the current colors. */
function syncQrBtnSwatches() {
  const fgSwatch = $('qr-fg-swatch');
  const bgSwatch = $('qr-bg-swatch');
  if (fgSwatch) fgSwatch.style.background = $('qr-fg-input').value;
  if (bgSwatch) bgSwatch.style.background = $('qr-bg-input').value;
}
$('qr-fg-input').addEventListener('input', syncQrBtnSwatches);
$('qr-bg-input').addEventListener('input', syncQrBtnSwatches);
$('qr-fg-btn').addEventListener('click', () => {
  qrPresetModalOpen('qr-fg-input', 'QR ფერი');
});
$('qr-bg-btn').addEventListener('click', () => {
  qrPresetModalOpen('qr-bg-input', 'ფონი');
});
$('qr-custom-btn').addEventListener('click', () => {
  qrColorModalOpen('qr-fg-input', 'QR ფერი', true);
});
syncQrBtnSwatches();

$('qr-maker-download').addEventListener('click', () => {
  if (!makerCurrent) return;
  const canvas = $('qr-maker-canvas');
  canvas.toBlob((blob) => {
    if (!blob) { toast('PNG შენახვა ვერ მოხერხდა'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = makerCurrent.label.replace(/[^A-Za-z0-9ა-ჰ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '-qr.png' || 'qr-code.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('QR კოდი გადმოიწერა');
  }, 'image/png');
});

/* ---------------- QR favorites ---------------- */

function readLocalFavorites() {
  try {
    const raw = localStorage.getItem(QR_FAV_LOCAL_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writeLocalFavorites(list) {
  try { localStorage.setItem(QR_FAV_LOCAL_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
}

function favCard(fav) {
  const card = document.createElement('div');
  card.className = 'link-card';
  const top = document.createElement('div');
  top.className = 'link-top';
  const title = document.createElement('span');
  title.className = 'link-note';
  title.textContent = fav.label;
  const badge = document.createElement('span');
  badge.className = 'badge type';
  badge.textContent = QR_TYPE_NAMES[fav.type] || fav.type;
  top.appendChild(title);
  top.appendChild(badge);
  const payload = document.createElement('p');
  payload.className = 'fav-payload';
  payload.textContent = fav.payload;
  const actions = document.createElement('div');
  actions.className = 'link-actions';
  const showBtn = document.createElement('button');
  showBtn.className = 'btn small';
  showBtn.textContent = 'ჩვენება';
  showBtn.addEventListener('click', () => {
    makerCurrent = { type: fav.type, label: fav.label, payload: fav.payload, fg: fav.fg, bg: fav.bg };
    $('qr-label-input').value = fav.label;
    $('qr-fg-input').value = fav.fg || '#000000';
    $('qr-bg-input').value = fav.bg || '#ffffff';
    syncQrBtnSwatches();
    renderMakerQr();
    $('qr-maker-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger-outline';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => { await deleteQrFavorite(fav); });
  actions.appendChild(showBtn);
  actions.appendChild(delBtn);
  card.appendChild(top);
  card.appendChild(payload);
  card.appendChild(actions);
  return card;
}

async function loadQrFavorites() {
  const listEl = $('qr-fav-list');
  const emptyEl = $('qr-fav-empty');
  if (!listEl) return;
  listEl.innerHTML = '';
  let favs = [];
  if (makerLoggedIn()) {
    try {
      const res = await fetch('/api/auth/qr-favorites', { credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        favs = (data.favorites || []).map((f) => ({
          id: f.id, type: f.type, label: f.label, payload: f.payload,
          fg: f.fg, bg: f.bg, createdAt: f.created_at,
        }));
      }
    } catch { favs = []; }
  } else {
    favs = readLocalFavorites();
  }
  emptyEl.hidden = favs.length > 0;
  for (const fav of favs) listEl.appendChild(favCard(fav));
}

async function deleteQrFavorite(fav) {
  if (!window.confirm('ნამდვილად წავშალო „' + fav.label + '"?')) return;
  if (typeof fav.id === 'number') {
    try {
      const res = await fetch('/api/auth/qr-favorites/' + fav.id, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) { toast('წაშლა ვერ მოხერხდა'); return; }
    } catch { toast('წაშლა ვერ მოხერხდა'); return; }
  } else {
    writeLocalFavorites(readLocalFavorites().filter((f) => f.id !== fav.id));
  }
  toast('რჩეული წაიშალა');
  loadQrFavorites();
}

$('qr-maker-save').addEventListener('click', async () => {
  if (!makerCurrent) { toast('ჯერ QR შექმენით'); return; }
  const fav = {
    type: makerCurrent.type,
    label: makerCurrent.label,
    payload: makerCurrent.payload,
    fg: makerCurrent.fg,
    bg: makerCurrent.bg,
  };
  if (makerLoggedIn()) {
    try {
      const res = await fetch('/api/auth/qr-favorites', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fav),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || ('შეცდომა: ' + res.status));
      toast('რჩეულებში შეინახა');
    } catch (e) {
      toast(e.message || 'შენახვა ვერ მოხერხდა');
      return;
    }
  } else {
    const list = readLocalFavorites();
    list.unshift({ id: 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1e6), ...fav, createdAt: Date.now() });
    writeLocalFavorites(list.slice(0, QR_FAV_LOCAL_MAX));
    toast('რჩეულებში შეინახა (ამ მოწყობილობაზე)');
  }
  loadQrFavorites();
});

// Favorites load after auth.js has run (login state is async): the first
// call uses localStorage, auth.js re-calls this on login/logout.
setTimeout(loadQrFavorites, 0);

/* ---------------- QR scanner ---------------- */
// Camera scanning uses the browser's built-in BarcodeDetector (Chrome on
// Android). Detection runs fully on-device — no video ever leaves the
// phone. Browsers without it get an honest message instead of a spinner.
let scanStream = null;
let scanRaf = null;

function stopScanner() {
  if (scanRaf) cancelAnimationFrame(scanRaf);
  scanRaf = null;
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  const video = $('qr-video');
  if (video) video.srcObject = null;
}

$('qr-scan-close').addEventListener('click', () => {
  stopScanner();
  $('qr-scanner').hidden = true;
});

$('qr-scan-btn').addEventListener('click', async () => {
  const box = $('qr-scanner');
  const status = $('qr-scan-status');
  const result = $('qr-scan-result');
  const actions = $('qr-scan-actions');
  box.hidden = false;
  result.hidden = true;
  actions.innerHTML = '';
  if (!('BarcodeDetector' in window)) {
    status.textContent = 'სკანირება ამ ბრაუზერში არ მუშაობს — გამოიყენეთ Chrome Android-ზე.';
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    status.textContent = 'კამერა მიუწვდომელია ამ მოწყობილობაზე.';
    return;
  }
  status.textContent = 'კამერას ვრთავ…';
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('qr-video');
    video.srcObject = scanStream;
    await video.play();
    status.textContent = 'QR კოდი კამერას მიუშვირეთ…';
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const off = document.createElement('canvas');
    const loop = async () => {
      if (!scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          onScanFound(codes[0].rawValue);
          return;
        }
      } catch { /* one failed frame — keep scanning */ }
      scanRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    status.textContent = 'კამერა ვერ გაიხსნა — შეამოწმეთ ნებართვა ბრაუზერის პარამეტრებში.';
    stopScanner();
  }
});

function onScanFound(value) {
  stopScanner();
  const status = $('qr-scan-status');
  const result = $('qr-scan-result');
  const actions = $('qr-scan-actions');
  status.textContent = 'ნაპოვნია:';
  result.textContent = value;
  result.hidden = false;
  actions.innerHTML = '';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    if (await copyText(value)) toast('დაკოპირდა');
    else toast('კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);
  if (/^https?:\/\//i.test(value)) {
    const openBtn = document.createElement('a');
    openBtn.className = 'btn small';
    openBtn.textContent = 'გახსნა';
    openBtn.href = value;
    openBtn.target = '_blank';
    openBtn.rel = 'noopener';
    actions.appendChild(openBtn);
  }
}
