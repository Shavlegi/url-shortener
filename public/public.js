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

/* ---------------- Theme ---------------- */
// Three themes (black / dark blue / white), saved per device in localStorage.
// The inline script in index.html already applied the saved theme before
// first paint; here we only sync the picker buttons.
const THEMES = ['black', 'blue', 'white'];

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'white';
  document.body.classList.remove('theme-black', 'theme-blue');
  if (name !== 'white') document.body.classList.add('theme-' + name);
  try { localStorage.setItem('minilink-theme', name); } catch { /* ignore */ }
  for (const th of THEMES) {
    const b = $('theme-' + th);
    if (b) b.classList.toggle('active', th === name);
  }
}

for (const th of THEMES) {
  const b = $('theme-' + th);
  if (b) b.addEventListener('click', () => applyTheme(th));
}

try {
  applyTheme(localStorage.getItem('minilink-theme') || 'white');
} catch { applyTheme('white'); }

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

function drawQr(canvas, text, size) {
  // qrcode-generator (vendored in qrcode.min.js): 0 = auto type number.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4; // quiet zone, in modules (required for reliable scanning)
  const total = count + quiet * 2;
  const scale = size / total;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
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
