/* Mini Link — admin dashboard (vanilla JS, no framework).
   All API calls are same-origin; the session cookie is HttpOnly, so the
   frontend never sees or stores credentials. */
'use strict';

const $ = (id) => document.getElementById(id);

const loginView = $('login-view');
const appView = $('app-view');
const toastEl = $('toast');

let links = [];
let toastTimer = null;

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

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw new Error((data && data.error) || ('შეცდომა: ' + res.status));
  }
  return data;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('ka-GE', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtExpiry(ms) {
  if (!ms) return 'უსასრულო';
  return new Date(ms).toLocaleDateString('ka-GE', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function isExpired(link) {
  return link.expiresAt !== null && link.expiresAt !== undefined && link.expiresAt <= Date.now();
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

/* ---------------- Auth ---------------- */

async function checkAuth() {
  try {
    const me = await api('/api/me');
    setAuthed(!!me.authenticated);
  } catch {
    setAuthed(false);
  }
}

function setAuthed(yes) {
  loginView.hidden = yes;
  appView.hidden = !yes;
  if (yes) { loadLinks(); loadUsers(); }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const err = $('login-error');
  hideError(err);
  btn.disabled = true;
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('login-password').value }),
    });
    $('login-password').value = '';
    toast('შესვლა წარმატებულია');
    setAuthed(true);
  } catch (err2) {
    showError(err, err2.message || 'შესვლა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  setAuthed(false);
  toast('გასული ხართ');
});

$('revoke-btn').addEventListener('click', async () => {
  if (!window.confirm('ყველა მოწყობილობიდან გამოვიდე? ამჟამინდელი სესიაც დაიხურება და ხელახლა შესვლა დაგჭირდებათ.')) return;
  try { await api('/api/sessions', { method: 'DELETE' }); } catch { /* ignore */ }
  setAuthed(false);
  toast('ყველა სესია დაიხურა');
});

/* ---------------- Links ---------------- */

async function loadLinks() {
  const err = $('links-error');
  hideError(err);
  const q = $('search-input').value.trim();
  try {
    const data = await api('/api/links' + (q ? ('?search=' + encodeURIComponent(q)) : ''));
    links = data.links || [];
    renderLinks();
  } catch (e) {
    showError(err, e.message || 'ბმულების ჩატვირთვა ვერ მოხერხდა.');
  }
}

function renderLinks() {
  const list = $('links-list');
  list.innerHTML = '';
  $('links-empty').hidden = links.length !== 0;
  for (const link of links) {
    list.appendChild(linkCard(link));
  }
}

function linkCard(link) {
  const card = document.createElement('div');
  card.className = 'link-card' + (link.enabled ? '' : ' disabled');

  const top = document.createElement('div');
  top.className = 'link-top';
  const alias = document.createElement('span');
  alias.className = 'link-alias';
  alias.textContent = link.shortUrl.replace(/^https?:\/\//, '');
  top.appendChild(alias);

  const badge = document.createElement('span');
  if (!link.enabled) { badge.className = 'badge off'; badge.textContent = 'გამორთული'; }
  else if (isExpired(link)) { badge.className = 'badge expired'; badge.textContent = 'ვადაგასული'; }
  else { badge.className = 'badge on'; badge.textContent = 'აქტიური'; }
  top.appendChild(badge);
  card.appendChild(top);

  const dest = document.createElement('p');
  dest.className = 'link-dest';
  const destA = document.createElement('a');
  destA.href = link.destination;
  destA.target = '_blank';
  destA.rel = 'noopener';
  destA.textContent = link.destination;
  dest.appendChild(destA);
  card.appendChild(dest);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = `👁 ${link.clicks} გახსნა · 👤 ${link.owner || 'ანონიმური'} · შექმნილია: ${fmtDate(link.createdAt)} · ვადა: ${fmtExpiry(link.expiresAt)}`;
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    if (await copyText(link.shortUrl)) toast('მოკლე ბმული დაკოპირდა');
    else toast('კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);

  const qrBtn = document.createElement('button');
  qrBtn.className = 'btn small';
  qrBtn.textContent = 'QR კოდი';
  qrBtn.addEventListener('click', () => openQr(link));
  actions.appendChild(qrBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn small';
  toggleBtn.textContent = link.enabled ? 'გამორთვა' : 'ჩართვა';
  toggleBtn.addEventListener('click', async () => {
    try {
      await api('/api/links/' + link.id, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !link.enabled }),
      });
      toast(link.enabled ? 'ბმული გამორთულია' : 'ბმული ჩართულია');
      loadLinks();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(toggleBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm('ნამდვილად წავშალო ბმული „' + link.alias + '"?')) return;
    try {
      await api('/api/links/' + link.id, { method: 'DELETE' });
      toast('ბმული წაიშალა');
      loadLinks();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadLinks, 350);
});

/* ---------------- Users (v2) ---------------- */

let users = [];

async function loadUsers() {
  const err = $('users-error');
  hideError(err);
  try {
    const data = await api('/api/admin/users');
    users = data.users || [];
    renderUsers();
  } catch (e) {
    showError(err, e.message || 'მომხმარებლების ჩატვირთვა ვერ მოხერხდა.');
  }
}

function filteredUsers() {
  const q = ($('user-search-input').value || '').trim().toLowerCase();
  if (!q) return users;
  return users.filter((u) =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q));
}

function renderUsers() {
  const list = $('users-list');
  list.innerHTML = '';
  const shown = filteredUsers();
  const q = ($('user-search-input').value || '').trim();
  $('users-empty').hidden = shown.length !== 0;
  $('users-empty').textContent = q
    ? 'მომხმარებელი ვერ მოიძებნა.'
    : 'მომხმარებლები ჯერ არ არიან.';
  for (const user of shown) {
    list.appendChild(userCard(user));
  }
}

// Live search: every keystroke filters the already-loaded users
// (username or email, case-insensitive substring) — no Enter, no reload.
$('user-search-input').addEventListener('input', renderUsers);

function userCard(user) {
  const card = document.createElement('div');
  card.className = 'link-card' + (user.disabled ? ' disabled' : '');

  const top = document.createElement('div');
  top.className = 'link-top';
  const name = document.createElement('span');
  name.className = 'link-alias';
  name.textContent = user.username;
  top.appendChild(name);

  const badge = document.createElement('span');
  if (user.disabled) { badge.className = 'badge off'; badge.textContent = 'გათიშული'; }
  else if (!user.emailVerified) { badge.className = 'badge expired'; badge.textContent = 'მეილი არ დასტურდება'; }
  else { badge.className = 'badge on'; badge.textContent = 'აქტიური'; }
  top.appendChild(badge);
  card.appendChild(top);

  const dest = document.createElement('p');
  dest.className = 'link-dest';
  dest.textContent = user.email;
  card.appendChild(dest);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = `🔗 ${user.linkCount} ბმული · რეგისტრირებულია: ${fmtDate(user.createdAt)}`;
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn small';
  toggleBtn.textContent = user.disabled ? 'ჩართვა' : 'გათიშვა';
  toggleBtn.addEventListener('click', async () => {
    const verb = user.disabled ? 'ჩართო' : 'გათიშო';
    if (!window.confirm(`ნამდვილად გინდა მომხმარებელი „${user.username}" ${verb}?`)) return;
    try {
      await api('/api/admin/users/' + user.id, {
        method: 'PATCH',
        body: JSON.stringify({ disabled: !user.disabled }),
      });
      toast(user.disabled ? 'მომხმარებელი ჩართულია' : 'მომხმარებელი გათიშულია');
      loadUsers();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(toggleBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm(`ნამდვილად წავშალო მომხმარებელი „${user.username}"? მისი ბმულები ანონიმური გახდება, მაგრამ მუშაობას გააგრძელებს.`)) return;
    try {
      const data = await api('/api/admin/users/' + user.id, { method: 'DELETE' });
      toast(`მომხმარებელი წაიშალა (${data.linksAnonymized || 0} ბმული ანონიმური გახდა)`);
      loadUsers();
      loadLinks();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

/* ---------------- Create link ---------------- */

let aliasTimer = null;
$('alias-input').addEventListener('input', () => {
  const hint = $('alias-hint');
  const value = $('alias-input').value.trim();
  hint.textContent = '';
  hint.className = 'hint';
  if (!value) return;
  clearTimeout(aliasTimer);
  aliasTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/check-alias?alias=' + encodeURIComponent(value), { credentials: 'same-origin' });
      const data = await res.json();
      if (data.available) { hint.textContent = 'ხელმისაწვდომია ✓'; hint.className = 'hint ok'; }
      else { hint.textContent = data.reason || 'დაკავებულია'; hint.className = 'hint bad'; }
    } catch { /* ignore check errors */ }
  }, 400);
});

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('create-btn');
  const err = $('create-error');
  const result = $('create-result');
  hideError(err);
  result.hidden = true;
  btn.disabled = true;

  const destination = $('dest-input').value.trim();
  const alias = $('alias-input').value.trim();
  const expiryDate = $('expiry-input').value; // yyyy-mm-dd or ''
  let expiresAt = null;
  if (expiryDate) {
    const d = new Date(expiryDate + 'T23:59:59');
    expiresAt = d.getTime();
  }

  try {
    const data = await api('/api/links', {
      method: 'POST',
      body: JSON.stringify({ destination, alias: alias || undefined, expiresAt }),
    });
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
    $('dest-input').value = '';
    $('alias-input').value = '';
    $('expiry-input').value = '';
    $('alias-hint').textContent = '';
    toast('ბმული შეიქმნა');
    loadLinks();
  } catch (e2) {
    showError(err, e2.message || 'ბმულის შექმნა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- QR ---------------- */

let currentQrLink = null;

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

/* ---------------- Export / Import ---------------- */

$('export-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/export', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('ექსპორტი ვერ მოხერხდა.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'links-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('ბექაფი გადმოიწერა');
  } catch (e) {
    toast(e.message || 'ექსპორტი ვერ მოხერხდა.');
  }
});

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast('ფაილი არასწორი JSON-ია.');
    return;
  }
  const items = Array.isArray(parsed) ? parsed : parsed.links;
  if (!Array.isArray(items)) {
    toast('ფაილში ბმულების სია ვერ მოიძებნა.');
    return;
  }
  try {
    const data = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({ links: items }),
    });
    toast(`იმპორტი: ${data.inserted} დამატდა, ${data.skipped} უკვე იყო, ${data.invalid} არასწორი`);
    loadLinks();
  } catch (err) {
    toast(err.message || 'იმპორტი ვერ მოხერხდა.');
  }
});

/* ---------------- Start ---------------- */

checkAuth();
