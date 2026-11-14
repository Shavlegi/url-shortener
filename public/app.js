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
  if (yes) {
    loadLinks(); loadUsers(); loadQrFavoritesAdmin(); loadVisitors(); loadExclusions();
    if (currentTab === 'chat') { loadChatUsers(); startChatPolling(); }
  } else {
    stopChatPolling();
  }
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

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  setAuthed(false);
  toast('გასული ხართ');
}

$('logout-btn').addEventListener('click', doLogout);
$('settings-logout-btn').addEventListener('click', doLogout);

$('revoke-btn').addEventListener('click', async () => {
  if (!window.confirm('ყველა მოწყობილობიდან გამოვიდე? ამჟამინდელი სესიაც დაიხურება და ხელახლა შესვლა დაგჭირდებათ.')) return;
  try { await api('/api/sessions', { method: 'DELETE' }); } catch { /* ignore */ }
  setAuthed(false);
  toast('ყველა სესია დაიხურა');
});

/* ---------------- Tabs (admin menu) ---------------- */

const TABS = ['links', 'users', 'qr', 'visitors', 'security', 'chat', 'create', 'stats', 'settings'];
let currentTab = 'links';
let activityPeriod = 'today';

function showTab(name) {
  if (!TABS.includes(name)) name = 'links';
  currentTab = name;
  // v10.9: the per-link log is a sub-view, not a tab — always hidden
  // when switching tabs.
  $('section-link-log').hidden = true;
  for (const t of TABS) {
    $('section-' + t).hidden = t !== name;
    $('tabbtn-' + t).classList.toggle('active', t === name);
  }
  if (name === 'stats') {
    renderStats();
    loadRecentClicks();
    loadVisitHours();
    loadPathStats();
    loadScreenStats();
  }
  if (name === 'qr') loadQrFavoritesAdmin();
  if (name === 'visitors') { loadVisitors(); loadExclusions(); }
  if (name === 'security') loadSecurityEvents();
  if (name === 'chat') {
    // Only load when logged in (appView starts hidden; setAuthed(true)
    // starts the chat load when the chat tab is already selected).
    if (!appView.hidden) {
      loadChatUsers();
      startChatPolling();
    }
  } else {
    stopChatPolling();
  }
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
}

for (const t of TABS) {
  $('tabbtn-' + t).addEventListener('click', () => showTab(t));
}

/* v7.2: single lilac-black theme for everyone — the theme picker was
   removed. Drop any stale saved theme so old devices get the one theme. */
try {
  localStorage.removeItem('minilink-theme');
  document.body.classList.remove('theme-black', 'theme-blue', 'theme-white');
} catch { /* ignore */ }

/* ---------------- Links ---------------- */

async function loadLinks() {
  const err = $('links-error');
  hideError(err);
  const q = $('search-input').value.trim();
  const sort = $('links-sort-select').value;
  const params = new URLSearchParams();
  if (q) params.set('search', q);
  if (sort && sort !== 'newest') params.set('sort', sort);
  const qs = params.toString();
  try {
    const data = await api('/api/links' + (qs ? ('?' + qs) : ''));
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
  renderStats();
}

/* ---------------- Share buttons ---------------- */
// One-tap share of a short link: WhatsApp / Telegram / Facebook open in
// a new tab; the native "გაზიარება" button opens the phone's share sheet
// (only shown where navigator.share exists).
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

/* ---------------- Link note (edit modal) ---------------- */

let currentNoteLink = null;

function openNoteModal(link) {
  currentNoteLink = link;
  $('note-modal-input').value = link.note || '';
  $('note-modal').hidden = false;
}

$('note-modal-save').addEventListener('click', async () => {
  if (!currentNoteLink) return;
  try {
    await api('/api/links/' + currentNoteLink.id, {
      method: 'PATCH',
      body: JSON.stringify({ note: $('note-modal-input').value }),
    });
    $('note-modal').hidden = true;
    toast('შენიშვნა შენახულია');
    loadLinks();
  } catch (e) { toast(e.message || 'შეცდომა'); }
});
$('note-modal-close').addEventListener('click', () => { $('note-modal').hidden = true; });
$('note-modal').addEventListener('click', (e) => {
  if (e.target === $('note-modal')) $('note-modal').hidden = true;
});

function linkCard(link) {
  const card = document.createElement('div');
  card.className = 'link-card' + (link.enabled ? '' : ' disabled');

  if (link.note) {
    const note = document.createElement('p');
    note.className = 'link-note';
    note.textContent = link.note;
    card.appendChild(note);
  }

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

  const historyBtn = document.createElement('button');
  historyBtn.className = 'btn small';
  historyBtn.textContent = 'ისტორია';
  historyBtn.addEventListener('click', () => openHistory(link));
  actions.appendChild(historyBtn);

  const noteBtn = document.createElement('button');
  noteBtn.className = 'btn small';
  noteBtn.textContent = '✏️ შენიშვნა';
  noteBtn.addEventListener('click', () => openNoteModal(link));
  actions.appendChild(noteBtn);

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

  // v10.9: per-link tracking toggles — custom-alias links ONLY. The
  // list is refetched after a toggle so the server-side auto-enable /
  // auto-disable rules (browser implies server) are reflected.
  if (link.isCustom) {
    const trackActions = document.createElement('div');
    trackActions.className = 'link-actions';

    const serverBtn = document.createElement('button');
    serverBtn.className = 'btn small' + (link.trackServer ? ' primary' : '');
    serverBtn.textContent = '👁 თვალთვალი';
    serverBtn.addEventListener('click', async () => {
      try {
        await api('/api/admin/links/' + link.id + '/tracking', {
          method: 'PATCH',
          body: JSON.stringify({ trackServer: !link.trackServer }),
        });
        toast(link.trackServer ? 'სერვერის თვალთვალი გამორთულია' : 'სერვერის თვალთვალი ჩართულია');
        loadLinks();
      } catch (e) { toast(e.message || 'შეცდომა'); }
    });
    trackActions.appendChild(serverBtn);

    const browserBtn = document.createElement('button');
    browserBtn.className = 'btn small' + (link.trackBrowser ? ' primary' : '');
    browserBtn.textContent = '🔍 ბრაუზერი';
    browserBtn.addEventListener('click', async () => {
      try {
        await api('/api/admin/links/' + link.id + '/tracking', {
          method: 'PATCH',
          body: JSON.stringify({ trackBrowser: !link.trackBrowser }),
        });
        toast(link.trackBrowser ? 'ბრაუზერის თვალთვალი გამორთულია' : 'ბრაუზერის თვალთვალი ჩართულია');
        loadLinks();
      } catch (e) { toast(e.message || 'შეცდომა'); }
    });
    trackActions.appendChild(browserBtn);

    const logBtn = document.createElement('button');
    logBtn.className = 'btn small';
    logBtn.textContent = '📊 ჟურნალი';
    logBtn.addEventListener('click', () => openLinkLog(link));
    trackActions.appendChild(logBtn);

    card.appendChild(trackActions);
  }

  card.appendChild(shareButtons(link));
  return card;
}

let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadLinks, 350);
});
$('links-sort-select').addEventListener('change', loadLinks);

/* ---------------- Link tracking log (v10.9) ---------------- */
// Dedicated per-link click log: a sub-view of the links tab, NOT a
// TABS entry. showTab() hides it; the back button returns to links.
let currentLogLink = null;
let logVisits = [];
let logTotal = 0;
let logOffset = 0;
const LOG_PAGE_SIZE = 50;

function openLinkLog(link) {
  currentLogLink = link;
  logOffset = 0;
  logVisits = [];
  $('link-log-search-input').value = '';
  for (const t of TABS) $('section-' + t).hidden = true;
  $('section-link-log').hidden = false;
  $('link-log-summary').textContent = link.shortUrl.replace(/^https?:\/\//, '') + ' → ' + link.destination +
    ' · 👁 თვალთვალი: ' + (link.trackServer ? 'ჩართული' : 'გამორთული') +
    ' · 🔍 ბრაუზერი: ' + (link.trackBrowser ? 'ჩართული' : 'გამორთული');
  loadLogVisits(false);
  $('section-link-log').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadLogVisits(append) {
  if (!currentLogLink) return;
  const err = $('link-log-error');
  hideError(err);
  if (!append) { logOffset = 0; logVisits = []; }
  const q = $('link-log-search-input').value.trim();
  const params = new URLSearchParams();
  params.set('limit', String(LOG_PAGE_SIZE));
  params.set('offset', String(logOffset));
  if (q) params.set('q', q);
  try {
    const data = await api('/api/admin/links/' + currentLogLink.id + '/visits?' + params.toString());
    logTotal = data.total || 0;
    logVisits = append ? logVisits.concat(data.visits || []) : (data.visits || []);
    logOffset = logVisits.length;
    renderLogVisits();
  } catch (e) {
    showError(err, e.message || 'ჟურნალის ჩატვირთვა ვერ მოხერხდა.');
  }
}

function renderLogVisits() {
  const list = $('link-log-list');
  list.innerHTML = '';
  $('link-log-totals').textContent = 'სულ ' + logTotal + ' ჩაწერილი დაჭერა';
  const q = ($('link-log-search-input').value || '').trim();
  $('link-log-empty').hidden = logVisits.length !== 0;
  $('link-log-empty').textContent = q ? 'ჩანაწერი ვერ მოიძებნა.' : 'დაჭერები ჯერ არ არის.';
  for (const v of logVisits) {
    list.appendChild(linkVisitCard(v));
  }
  $('link-log-more-btn').hidden = logVisits.length >= logTotal;
}

function linkVisitCard(v) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const top = document.createElement('div');
  top.className = 'link-top';
  const ip = document.createElement('span');
  ip.className = 'link-alias';
  ip.textContent = v.ip;
  top.appendChild(ip);
  card.appendChild(top);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = fmtDate(v.visitedAt);
  card.appendChild(meta);

  const geoParts = [];
  if (v.country) geoParts.push(v.country === 'T1' ? '🧅 Tor' : v.country);
  if (v.city) geoParts.push(v.city);
  if (v.region && v.region !== v.city) geoParts.push(v.region);
  if (v.postalCode) geoParts.push(v.postalCode);
  if (v.latitude !== null && v.latitude !== undefined && v.longitude !== null && v.longitude !== undefined) {
    geoParts.push(Number(v.latitude).toFixed(2) + ', ' + Number(v.longitude).toFixed(2));
  }
  if (v.timezone) geoParts.push(v.timezone);
  if (v.isp) geoParts.push(v.isp + (v.asn !== null && v.asn !== undefined ? ' (AS' + v.asn + ')' : ''));
  if (v.isEu) geoParts.push('EU');
  if (geoParts.length > 0) {
    const geoEl = document.createElement('p');
    geoEl.className = 'link-meta';
    geoEl.textContent = '🌍 ' + geoParts.join(' · ');
    card.appendChild(geoEl);
  }

  const devParts = [];
  if (v.os) devParts.push(v.os);
  if (v.browser) devParts.push(v.browser);
  if (v.device) devParts.push(v.device === 'mobile' ? 'მობილური' : v.device === 'tablet' ? 'პლანშეტი' : 'კომპიუტერი');
  if (devParts.length > 0) {
    const devEl = document.createElement('p');
    devEl.className = 'link-meta';
    devEl.textContent = '📱 ' + devParts.join(' · ');
    card.appendChild(devEl);
  }

  const miscParts = [];
  if (v.language) miscParts.push('🔤 ' + v.language);
  if (v.referrer) miscParts.push('🔗 ' + v.referrer);
  if (miscParts.length > 0) {
    const miscEl = document.createElement('p');
    miscEl.className = 'link-meta';
    miscEl.textContent = miscParts.join(' · ');
    card.appendChild(miscEl);
  }

  if (v.browserData) {
    const b = v.browserData;
    const bParts = [];
    if (b.screen) bParts.push('ეკრანი: ' + b.screen + (b.refreshRate ? ' @ ' + b.refreshRate + 'Hz' : ''));
    if (b.gpu) bParts.push('GPU: ' + b.gpu);
    if (b.orientation) bParts.push('ორიენტაცია: ' + b.orientation);
    if (b.colorScheme) bParts.push('თემა: ' + (b.colorScheme === 'dark' ? 'მუქი' : 'ღია'));
    if (b.touchPoints !== null && b.touchPoints !== undefined) bParts.push('შეხება: ' + b.touchPoints);
    if (b.incognito !== null && b.incognito !== undefined) bParts.push('ინკოგნიტო: ' + (b.incognito ? 'კი' : 'არა'));
    if (b.adblock !== null && b.adblock !== undefined) bParts.push('რეკლამის ბლოკერი: ' + (b.adblock ? 'კი' : 'არა'));
    if (b.batteryLevel !== null && b.batteryLevel !== undefined) bParts.push('ბატარეა: ' + b.batteryLevel + '%' + (b.charging ? ' · იტენება' : ''));
    if (b.browserTimezone) bParts.push('ბრაუზერის სარტყელი: ' + b.browserTimezone);
    if (b.languages && b.languages.length > 0) bParts.push('ენები: ' + b.languages.join(', '));
    if (b.cores) bParts.push('ბირთვები: ' + b.cores);
    if (b.deviceMemory !== null && b.deviceMemory !== undefined) bParts.push('მეხსიერება: ' + b.deviceMemory + ' GB');
    if (b.connection) bParts.push('კავშირი: ' + b.connection);
    if (b.fingerprint) bParts.push('ანაბეჭდი: ' + b.fingerprint);
    if (bParts.length > 0) {
      const bEl = document.createElement('p');
      bEl.className = 'link-meta';
      bEl.textContent = '🔍 ' + bParts.join(' · ');
      card.appendChild(bEl);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.type = 'button';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    if (await copyText(v.ip)) toast('IP დაკოპირდა');
    else toast('კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);
  card.appendChild(actions);
  return card;
}

let logSearchTimer = null;
$('link-log-search-input').addEventListener('input', () => {
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => loadLogVisits(false), 350);
});
$('link-log-more-btn').addEventListener('click', () => loadLogVisits(true));
$('link-log-back-btn').addEventListener('click', () => showTab('links'));
$('link-log-export-btn').addEventListener('click', () => {
  if (!currentLogLink) return;
  window.open('/api/admin/links/' + currentLogLink.id + '/visits/export', '_blank');
});
$('link-log-clear-btn').addEventListener('click', async () => {
  if (!currentLogLink) return;
  if (!window.confirm('ნამდვილად გავასუფთაო ამ ბმულის დაჭერების ჟურნალი?')) return;
  try {
    await api('/api/admin/links/' + currentLogLink.id + '/visits', { method: 'DELETE' });
    toast('ჟურნალი გასუფთავდა');
    loadLogVisits(false);
  } catch (e) { toast(e.message || 'შეცდომა'); }
});

/* ---------------- QR favorites (v5, admin view) ---------------- */
// The admin sees every logged-in user's saved QR codes, like links:
// label + type + payload + colors + owner, with show (QR modal) and
// delete. Anonymous favorites never reach the server (localStorage only).
let qrFavs = [];
let qrFavLoaded = false;

const QR_TYPE_NAMES = {
  link: 'ბმული',
  instagram: 'Instagram',
  wifi: 'Wi-Fi',
  phone: 'ტელეფონი',
  text: 'ტექსტი',
  review: 'Google შეფასება',
};

async function loadQrFavoritesAdmin() {
  const err = $('qr-error');
  hideError(err);
  try {
    const data = await api('/api/qr-favorites');
    qrFavs = data.favorites || [];
    qrFavLoaded = true;
    renderQrFavorites();
  } catch (e) {
    showError(err, e.message || 'QR კოდების ჩატვირთვა ვერ მოხერხდა.');
  }
}

function filteredQrFavs() {
  const q = ($('qr-search-input').value || '').trim().toLowerCase();
  if (!q) return qrFavs;
  return qrFavs.filter((f) =>
    (f.label || '').toLowerCase().includes(q) ||
    (f.owner || '').toLowerCase().includes(q) ||
    (f.payload || '').toLowerCase().includes(q) ||
    (QR_TYPE_NAMES[f.type] || f.type || '').toLowerCase().includes(q));
}

function sortedQrFavs(list) {
  const sort = $('qr-sort-select').value;
  const arr = [...list];
  if (sort === 'oldest') arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  else arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return arr;
}

function renderQrFavorites() {
  const list = $('qr-list');
  list.innerHTML = '';
  const shown = sortedQrFavs(filteredQrFavs());
  const q = ($('qr-search-input').value || '').trim();
  $('qr-empty').hidden = shown.length !== 0;
  $('qr-empty').textContent = q ? 'QR კოდი ვერ მოიძებნა.' : 'QR კოდები ჯერ არ არის.';
  for (const fav of shown) list.appendChild(qrFavCard(fav));
  renderStats();
}

function qrFavCard(fav) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const title = document.createElement('p');
  title.className = 'link-note';
  title.textContent = fav.label;
  card.appendChild(title);

  const top = document.createElement('div');
  top.className = 'link-top';
  const type = document.createElement('span');
  type.className = 'link-alias';
  type.textContent = QR_TYPE_NAMES[fav.type] || fav.type;
  top.appendChild(type);
  if (fav.favorite) {
    const star = document.createElement('span');
    star.className = 'badge fav';
    star.textContent = '⭐ რჩეული';
    top.appendChild(star);
  }
  const badge = document.createElement('span');
  badge.className = 'badge type';
  badge.textContent = '👤 ' + (fav.owner || 'ანონიმური');
  // v6.2: tapping the owner's name opens their profile (same modal as the
  // Users tab). Anonymous rows have no owner, so they stay plain text.
  if (fav.owner) {
    badge.classList.add('badge-link');
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.title = 'პროფილის ნახვა';
    const openOwnerProfile = () => {
      const user = users.find((u) => u.username === fav.owner);
      if (user) openProfile(user);
      else toast('მომხმარებელი ვერ მოიძებნა');
    };
    badge.addEventListener('click', openOwnerProfile);
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOwnerProfile(); }
    });
  }
  top.appendChild(badge);
  card.appendChild(top);

  const payload = document.createElement('p');
  payload.className = 'fav-payload';
  payload.textContent = fav.payload;
  card.appendChild(payload);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = 'შექმნილია: ' + fmtDate(fav.createdAt);
  card.appendChild(meta);

  const colors = document.createElement('p');
  colors.className = 'link-meta';
  colors.textContent = 'ფერები: ';
  const fgSw = document.createElement('span');
  fgSw.className = 'color-dot';
  fgSw.style.background = fav.fg || '#000000';
  fgSw.title = 'QR ფერი';
  const bgSw = document.createElement('span');
  bgSw.className = 'color-dot';
  bgSw.style.background = fav.bg || '#ffffff';
  bgSw.title = 'ფონი';
  colors.appendChild(fgSw);
  colors.appendChild(bgSw);
  card.appendChild(colors);

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const showBtn = document.createElement('button');
  showBtn.className = 'btn small';
  showBtn.textContent = 'QR ჩვენება';
  showBtn.addEventListener('click', () => openQrFavorite(fav));
  actions.appendChild(showBtn);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    if (await copyText(fav.payload)) toast('დაკოპირდა');
    else toast('კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm('ნამდვილად წავშალო QR „' + fav.label + '"?')) return;
    try {
      await api('/api/qr-favorites/' + fav.id, { method: 'DELETE' });
      toast('QR კოდი წაიშალა');
      loadQrFavoritesAdmin();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

// Live search: every keystroke filters the already-loaded favorites.
$('qr-search-input').addEventListener('input', renderQrFavorites);
$('qr-sort-select').addEventListener('change', renderQrFavorites);

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

// Users list filter: 'all' or 'active' (set from the stats cards).
let userFilter = 'all';

function filteredUsers() {
  const q = ($('user-search-input').value || '').trim().toLowerCase();
  let list = users;
  if (userFilter === 'active') list = list.filter((u) => u.emailVerified && !u.disabled);
  if (!q) return list;
  return list.filter((u) =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q));
}

function sortedUsers(list) {
  const sort = $('users-sort-select').value;
  const arr = [...list];
  if (sort === 'oldest') arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  else arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return arr;
}

function renderUsers() {
  const list = $('users-list');
  list.innerHTML = '';
  const shown = sortedUsers(filteredUsers());
  const q = ($('user-search-input').value || '').trim();
  $('user-filter-note').hidden = userFilter !== 'active';
  $('users-empty').hidden = shown.length !== 0;
  $('users-empty').textContent = q
    ? 'მომხმარებელი ვერ მოიძებნა.'
    : (userFilter === 'active' ? 'აქტიური მომხმარებლები არ არიან.' : 'მომხმარებლები ჯერ არ არიან.');
  for (const user of shown) {
    list.appendChild(userCard(user));
  }
  renderStats();
}

$('user-filter-clear').addEventListener('click', () => {
  userFilter = 'all';
  renderUsers();
});

// Live search: every keystroke filters the already-loaded users
// (username or email, case-insensitive substring) — no Enter, no reload.
$('user-search-input').addEventListener('input', renderUsers);
$('users-sort-select').addEventListener('change', renderUsers);

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
  meta.textContent = `🔗 ${user.linkCount} ბმული · 📱 ${user.qrCount || 0} QR · რეგისტრირებულია: ${fmtDate(user.createdAt)}`;
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const profileBtn = document.createElement('button');
  profileBtn.className = 'btn small';
  profileBtn.textContent = 'პროფილი';
  profileBtn.addEventListener('click', () => openProfile(user));
  actions.appendChild(profileBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn small';
  toggleBtn.textContent = user.disabled ? 'ჩართვა' : 'გათიშვა';
  toggleBtn.addEventListener('click', () => setUserDisabled(user, !user.disabled));
  actions.appendChild(toggleBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', () => removeUser(user));
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

async function setUserDisabled(user, disabled) {
  const verb = disabled ? 'გათიშო' : 'ჩართო';
  if (!window.confirm(`ნამდვილად გინდა მომხმარებელი „${user.username}" ${verb}?`)) return false;
  try {
    await api('/api/admin/users/' + user.id, {
      method: 'PATCH',
      body: JSON.stringify({ disabled }),
    });
    toast(disabled ? 'მომხმარებელი გათიშულია' : 'მომხმარებელი ჩართულია');
    loadUsers();
    loadLinks();
    return true;
  } catch (e) { toast(e.message || 'შეცდომა'); return false; }
}

async function removeUser(user) {
  if (!window.confirm(`ნამდვილად წავშალო მომხმარებელი „${user.username}"? მისი ბმულები ანონიმური გახდება, მაგრამ მუშაობას გააგრძელებს.`)) return false;
  try {
    const data = await api('/api/admin/users/' + user.id, { method: 'DELETE' });
    toast(`მომხმარებელი წაიშალა (${data.linksAnonymized || 0} ბმული ანონიმური გახდა)`);
    loadUsers();
    loadLinks();
    return true;
  } catch (e) { toast(e.message || 'შეცდომა'); return false; }
}

/* ---------------- User profile card ---------------- */

let currentProfileUser = null;

async function openProfile(user) {
  currentProfileUser = user;
  $('profile-title').textContent = '👤 ' + user.username;
  $('profile-email').textContent = user.email;
  $('profile-status').textContent = user.disabled ? 'გათიშული' : (!user.emailVerified ? 'მეილი არ დასტურდება' : 'აქტიური');
  $('profile-created').textContent = 'რეგისტრირებულია: ' + fmtDate(user.createdAt);
  $('profile-toggle-btn').textContent = user.disabled ? 'ჩართვა' : 'გათიშვა';
  $('profile-count').textContent = 'ბმულები იტვირთება…';
  $('profile-links').innerHTML = '';
  $('profile-links-empty').hidden = true;
  // v8.0: public profile page section (profile fields come with the
  // users list, so no extra call is needed).
  const hasProfile = !!user.hasProfile;
  $('profile-page-status').textContent = hasProfile
    ? `🌐 პროფილი: ${user.profileLinkCount || 0} / ${user.profileLinkLimit ?? 5} ბმული · 👁 ${user.profileViewCount || 0} ნახვა`
    : '🌐 პროფილი: არ აქვს შექმნილი';
  $('profile-page-link-row').hidden = !hasProfile;
  if (hasProfile) {
    const pageLink = $('profile-page-link');
    pageLink.href = 'https://minilink.space/@' + user.username;
    pageLink.textContent = 'minilink.space/@' + user.username;
  }
  $('profile-limit-row').hidden = !hasProfile;
  if (hasProfile) $('profile-limit-input').value = String(user.profileLinkLimit ?? 5);
  hideError($('profile-limit-error'));
  $('profile-modal').hidden = false;
  try {
    // Fresh load without the links search filter, so the profile is complete.
    const data = await api('/api/links');
    const mine = (data.links || []).filter((l) => l.owner === user.username);
    const totalClicks = mine.reduce((s, l) => s + (l.clicks || 0), 0);
    if (!qrFavLoaded) {
      try { await loadQrFavoritesAdmin(); } catch { /* QR count stays 0 */ }
    }
    const qrMine = qrFavs.filter((f) => f.owner === user.username);
    $('profile-count').textContent = mine.length + ' ბმული · ' + totalClicks + ' გახსნა · ' + qrMine.length + ' QR კოდი';
    $('profile-links-empty').hidden = mine.length !== 0;
    for (const link of mine) $('profile-links').appendChild(profileLinkRow(link));
  } catch (e) {
    $('profile-count').textContent = 'ბმულების ჩატვირთვა ვერ მოხერხდა.';
  }
}

function profileLinkRow(link) {
  const card = document.createElement('div');
  card.className = 'link-card';
  const top = document.createElement('div');
  top.className = 'link-top';
  const alias = document.createElement('span');
  alias.className = 'link-alias';
  alias.textContent = link.note || link.shortUrl.replace(/^https?:\/\//, '');
  top.appendChild(alias);
  const badge = document.createElement('span');
  badge.className = 'badge ' + (link.enabled ? 'on' : 'off');
  badge.textContent = link.enabled ? 'აქტიური' : 'გამორთული';
  top.appendChild(badge);
  card.appendChild(top);
  const dest = document.createElement('p');
  dest.className = 'link-dest';
  dest.textContent = link.destination;
  card.appendChild(dest);
  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = `👁 ${link.clicks} გახსნა · შექმნილია: ${fmtDate(link.createdAt)}`;
  card.appendChild(meta);
  return card;
}

$('profile-toggle-btn').addEventListener('click', async () => {
  const user = currentProfileUser;
  if (!user) return;
  const ok = await setUserDisabled(user, !user.disabled);
  if (ok) {
    user.disabled = !user.disabled;
    openProfile(user);
  }
});

$('profile-delete-btn').addEventListener('click', async () => {
  const user = currentProfileUser;
  if (!user) return;
  const ok = await removeUser(user);
  if (ok) $('profile-modal').hidden = true;
});

// v8.0: raise/lower one user's profile button limit (1–100). The
// server returns 404 profile_not_found when the user has no profile.
$('profile-limit-save-btn').addEventListener('click', async () => {
  const user = currentProfileUser;
  if (!user) return;
  const err = $('profile-limit-error');
  hideError(err);
  const limit = parseInt($('profile-limit-input').value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    showError(err, 'ლიმიტი 1–100 შორის უნდა იყოს.');
    return;
  }
  try {
    await api('/api/admin/users/' + user.id + '/link-limit', {
      method: 'POST',
      body: JSON.stringify({ link_limit: limit }),
    });
    user.profileLinkLimit = limit;
    toast('ლიმიტი შენახულია');
    loadUsers();
    openProfile(user);
  } catch (e) {
    showError(err, e.message || 'შენახვა ვერ მოხერხდა.');
  }
});

$('profile-close').addEventListener('click', () => { $('profile-modal').hidden = true; });
$('profile-modal').addEventListener('click', (e) => {
  if (e.target === $('profile-modal')) $('profile-modal').hidden = true;
});

/* ---------------- Visitors (v10.0) ---------------- */
// Visitor IPs — admin only. Search + sort run server-side
// (see GET /api/admin/visitors). List loads on login and when the tab opens.
let visitors = [];
let visitorTotals = { totalDevices: 0, totalVisits: 0, totalFavorites: 0 };
// v10.8: favorites-only view — the flag rides on every list fetch, so the
// existing search + sort controls keep working on the filtered set.
let favoritesOnly = false;

async function loadVisitors() {
  const err = $('visitors-error');
  hideError(err);
  const q = $('visitor-search-input').value.trim();
  const sort = $('visitor-sort-select').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sort) params.set('sort', sort);
  if (favoritesOnly) params.set('favorites', '1');
  const qs = params.toString();
  try {
    const data = await api('/api/admin/visitors' + (qs ? ('?' + qs) : ''));
    visitors = data.visitors || [];
    visitorTotals = { totalDevices: data.totalDevices || 0, totalVisits: data.totalVisits || 0, totalFavorites: data.totalFavorites || 0 };
    renderVisitors();
  } catch (e) {
    showError(err, e.message || 'სტუმრების ჩატვირთვა ვერ მოხერხდა.');
  }
}

function renderVisitors() {
  const list = $('visitors-list');
  list.innerHTML = '';
  $('visitors-totals').textContent = 'სულ ' + visitorTotals.totalDevices + ' მოწყობილობა · ' + visitorTotals.totalVisits + ' ვიზიტი · ⭐ ფავორიტი: ' + visitorTotals.totalFavorites;
  const statEl = $('stat-visitors');
  if (statEl) statEl.textContent = String(visitorTotals.totalDevices);
  const q = ($('visitor-search-input').value || '').trim();
  $('visitors-empty').hidden = visitors.length !== 0;
  $('visitors-empty').textContent = q ? 'IP ვერ მოიძებნა.' : (favoritesOnly ? 'ფავორიტები ჯერ არ არის.' : 'სტუმრები ჯერ არ არიან.');
  for (const v of visitors) {
    list.appendChild(visitorCard(v));
  }
}

function visitorCard(v) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const top = document.createElement('div');
  top.className = 'link-top';
  const ip = document.createElement('span');
  ip.className = 'link-alias';
  ip.textContent = v.ip;
  top.appendChild(ip);
  card.appendChild(top);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = v.visits + ' ვიზიტი · პირველი: ' + fmtDate(v.firstSeen) + ' · ბოლო: ' + fmtDate(v.lastSeen) + (v.favorite ? ' · ⭐ ფავორიტი' : '');
  card.appendChild(meta);

  if (v.users && v.users.length > 0) {
    const usersEl = document.createElement('p');
    usersEl.className = 'link-meta';
    usersEl.textContent = '👤 ' + v.users.map((u) => u.username).join(' · ');
    card.appendChild(usersEl);
  }

  const geoParts = [];
  if (v.country) geoParts.push(v.country === 'T1' ? '🧅 Tor' : v.country);
  if (v.city) geoParts.push(v.city);
  if (v.region && v.region !== v.city) geoParts.push(v.region);
  if (v.postalCode) geoParts.push(v.postalCode);
  if (v.latitude !== null && v.latitude !== undefined && v.longitude !== null && v.longitude !== undefined) {
    geoParts.push(Number(v.latitude).toFixed(2) + ', ' + Number(v.longitude).toFixed(2));
  }
  if (v.timezone) geoParts.push(v.timezone);
  if (v.isp) geoParts.push(v.isp + (v.asn !== null && v.asn !== undefined ? ' (AS' + v.asn + ')' : ''));
  if (v.isEu) geoParts.push('EU');
  if (geoParts.length > 0) {
    const geoEl = document.createElement('p');
    geoEl.className = 'link-meta';
    geoEl.textContent = '🌍 ' + geoParts.join(' · ');
    card.appendChild(geoEl);
  }

  const devParts = [];
  if (v.os) devParts.push(v.os);
  if (v.browser) devParts.push(v.browser);
  if (v.device) devParts.push(v.device === 'mobile' ? 'მობილური' : v.device === 'tablet' ? 'პლანშეტი' : 'კომპიუტერი');
  if (devParts.length > 0) {
    const devEl = document.createElement('p');
    devEl.className = 'link-meta';
    devEl.textContent = '📱 ' + devParts.join(' · ');
    card.appendChild(devEl);
  }

  const miscParts = [];
  if (v.language) miscParts.push('🔤 ' + v.language);
  if (v.referrer) miscParts.push('🔗 ' + v.referrer);
  if (miscParts.length > 0) {
    const miscEl = document.createElement('p');
    miscEl.className = 'link-meta';
    miscEl.textContent = miscParts.join(' · ');
    card.appendChild(miscEl);
  }

  if (v.lastPath) {
    const pathEl = document.createElement('p');
    pathEl.className = 'link-meta';
    pathEl.textContent = 'ბოლო გვერდი: ' + v.lastPath;
    card.appendChild(pathEl);
  }

  if (v.note) {
    const noteEl = document.createElement('p');
    noteEl.className = 'link-meta';
    noteEl.textContent = '📝 ' + v.note;
    card.appendChild(noteEl);
  }

  const noteEditor = document.createElement('div');
  noteEditor.hidden = true;
  const noteInput = document.createElement('textarea');
  noteInput.rows = 3;
  noteInput.maxLength = 500;
  noteInput.value = v.note || '';
  noteInput.placeholder = 'შენიშვნა ამ IP-ზე…';
  noteInput.style.cssText = 'margin:8px 0;';
  noteEditor.appendChild(noteInput);
  const noteActions = document.createElement('div');
  noteActions.className = 'result-actions';
  const noteSave = document.createElement('button');
  noteSave.className = 'btn small primary';
  noteSave.type = 'button';
  noteSave.textContent = 'შენახვა';
  noteSave.addEventListener('click', async () => {
    try {
      await api('/api/admin/visitors', { method: 'PATCH', body: JSON.stringify({ ip: v.ip, note: noteInput.value }) });
      toast('შენიშვნა შეინახა');
      loadVisitors();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  noteActions.appendChild(noteSave);
  const noteCancel = document.createElement('button');
  noteCancel.className = 'btn small';
  noteCancel.type = 'button';
  noteCancel.textContent = 'გაუქმება';
  noteCancel.addEventListener('click', () => {
    noteInput.value = v.note || '';
    noteEditor.hidden = true;
  });
  noteActions.appendChild(noteCancel);
  noteEditor.appendChild(noteActions);

  const eventsWrap = document.createElement('div');
  eventsWrap.hidden = true;
  const eventsList = document.createElement('div');
  eventsList.className = 'links-list';
  eventsWrap.appendChild(eventsList);

  async function loadEvents() {
    eventsList.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'link-meta';
    loading.textContent = 'იტვირთება…';
    eventsList.appendChild(loading);
    try {
      const data = await api('/api/admin/visitor-events?ip=' + encodeURIComponent(v.ip));
      eventsList.innerHTML = '';
      const events = data.events || [];
      if (events.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'link-meta';
        empty.textContent = 'მონაცემები არ არის.';
        eventsList.appendChild(empty);
        return;
      }
      for (const ev of events) {
        const row = document.createElement('p');
        row.className = 'link-meta';
        const sessionShort = String(ev.session || '').slice(0, 8);
        let desc = '';
        if (ev.type === 'pageview') desc = 'გახსნა: ' + (ev.path || '/');
        else if (ev.type === 'click') desc = 'დააჭირა: ' + (ev.label || '');
        else if (ev.type === 'time') desc = 'გვერდზე: ' + (ev.seconds || 0) + ' წამი' + (ev.scroll !== null && ev.scroll !== undefined ? ' · სქროლი ' + ev.scroll + '%' : '');
        else desc = ev.type;
        row.textContent = '[' + sessionShort + '] ' + fmtDate(ev.createdAt) + ' — ' + desc;
        eventsList.appendChild(row);
      }
    } catch (e) {
      eventsList.innerHTML = '';
      const err = document.createElement('p');
      err.className = 'error';
      err.textContent = e.message || 'შეცდომა';
      eventsList.appendChild(err);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.type = 'button';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(v.ip);
    toast(ok ? 'IP დაკოპირდა' : 'კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);
  const excludeBtn = document.createElement('button');
  excludeBtn.className = 'btn small';
  excludeBtn.type = 'button';
  excludeBtn.textContent = '🚫 გამონაკლისში';
  excludeBtn.addEventListener('click', async () => {
    try {
      await api('/api/admin/ip-exclusions', { method: 'POST', body: JSON.stringify({ ip: v.ip }) });
      toast('IP გამონაკლისებში დაემატა');
      loadVisitors();
      loadExclusions();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(excludeBtn);
  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger-outline';
  delBtn.type = 'button';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm('ნამდვილად წავშალო IP „' + v.ip + '"?')) return;
    try {
      await api('/api/admin/visitors?ip=' + encodeURIComponent(v.ip), { method: 'DELETE' });
      toast('IP წაიშალა');
      loadVisitors();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(delBtn);
  const noteBtn = document.createElement('button');
  noteBtn.className = 'btn small';
  noteBtn.type = 'button';
  noteBtn.textContent = '📝 შენიშვნა';
  noteBtn.addEventListener('click', () => {
    eventsWrap.hidden = true;
    noteEditor.hidden = !noteEditor.hidden;
  });
  actions.appendChild(noteBtn);
  // v10.7: favorite toggle — favorites are exempt from the 90-day
  // prune, age cleanup and clear-all. No confirm: fully reversible.
  const favBtn = document.createElement('button');
  favBtn.className = 'btn small';
  favBtn.type = 'button';
  favBtn.textContent = v.favorite ? '★ ფავორიტებიდან მოხსნა' : '⭐ ფავორიტებში';
  favBtn.addEventListener('click', async () => {
    try {
      await api('/api/admin/visitors', { method: 'PATCH', body: JSON.stringify({ ip: v.ip, favorite: !v.favorite }) });
      toast(v.favorite ? 'ფავორიტებიდან მოიხსნა' : 'ფავორიტებში დაემატა');
      loadVisitors();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(favBtn);
  const trackBtn = document.createElement('button');
  trackBtn.className = 'btn small';
  trackBtn.type = 'button';
  trackBtn.textContent = '👁 თვალთვალი';
  trackBtn.addEventListener('click', () => {
    noteEditor.hidden = true;
    const willShow = eventsWrap.hidden;
    eventsWrap.hidden = !willShow;
    if (willShow) loadEvents();
  });
  actions.appendChild(trackBtn);
  card.appendChild(actions);
  card.appendChild(noteEditor);
  card.appendChild(eventsWrap);
  return card;
}

let visitorSearchTimer = null;
$('visitor-search-input').addEventListener('input', () => {
  clearTimeout(visitorSearchTimer);
  visitorSearchTimer = setTimeout(loadVisitors, 350);
});
$('visitor-sort-select').addEventListener('change', loadVisitors);
// v10.8: favorites-only toggle — refetches the list with favorites=1;
// the search + sort controls keep working on the filtered set. The list
// sits above the exclusions block, so scroll it into view on toggle.
$('favorites-toggle-btn').addEventListener('click', () => {
  favoritesOnly = !favoritesOnly;
  $('favorites-toggle-btn').classList.toggle('primary', favoritesOnly);
  loadVisitors();
  $('section-visitors').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('visitors-clear-btn').addEventListener('click', async () => {
  if (!window.confirm('ნამდვილად გაასუფთავო სტუმრების სია? ფავორიტებში შენახული IP-ები არ წაიშლება. ეს მოქმედება უკან ვერ დაბრუნდება.')) return;
  try {
    const data = await api('/api/admin/visitors', { method: 'DELETE' });
    toast('გასუფთავდა: ' + (data.deleted || 0) + ' ჩანაწერი');
    loadVisitors();
  } catch (e) { toast(e.message || 'შეცდომა'); }
});

const CLEANUP_BTNS = { 'visitors-clean-7-btn': 7, 'visitors-clean-30-btn': 30, 'visitors-clean-90-btn': 90 };
for (const [id, days] of Object.entries(CLEANUP_BTNS)) {
  $(id).addEventListener('click', async () => {
    if (!window.confirm('წაიშლება ' + days + ' დღეზე ძველი ყველა ჩანაწერი (სტუმრები, მოვლენები, სტატისტიკა; ფავორიტების გარდა). გაგრძელება?')) return;
    try {
      const data = await api('/api/admin/visitors?olderThanDays=' + days, { method: 'DELETE' });
      const d = data.deleted || {};
      toast('წაიშალა: ' + (d.visitors || 0) + ' სტუმარი, ' + (d.events || 0) + ' მოვლენა');
      loadVisitors();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
}

/* ---------------- Security event log (v10.6) ---------------- */
// Admin-only: failed logins, rate-limited logins, Turnstile failures,
// wrong email codes, blocked destinations. Newest first.
let securityEvents = [];
let securityTotal = 0;

const SECURITY_TYPE_LABELS = {
  login_failed: '❌ წარუმატებელი შესვლა',
  login_rate_limited: '⏱ ლიმიტი (შესვლა)',
  turnstile_failed: '🤖 Turnstile ჩავარდა',
  code_failed: '🔢 არასწორი კოდი',
  blocked_url: '🚫 დაბლოკილი ბმული',
};

async function loadSecurityEvents() {
  const err = $('security-error');
  hideError(err);
  const type = $('security-type-select').value;
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  params.set('limit', '100');
  try {
    const data = await api('/api/admin/security-events?' + params.toString());
    securityEvents = data.events || [];
    securityTotal = data.total || 0;
    renderSecurityEvents();
  } catch (e) {
    showError(err, e.message || 'უსაფრთხოების ლოგის ჩატვირთვა ვერ მოხერხდა.');
  }
}

function renderSecurityEvents() {
  const list = $('security-list');
  list.innerHTML = '';
  $('security-totals').textContent = 'სულ ' + securityTotal + ' ჩანაწერი';
  $('security-empty').hidden = securityEvents.length !== 0;
  for (const ev of securityEvents) {
    list.appendChild(securityEventCard(ev));
  }
}

function securityEventCard(ev) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const top = document.createElement('div');
  top.className = 'link-top';
  const label = document.createElement('span');
  label.className = 'link-alias';
  label.textContent = SECURITY_TYPE_LABELS[ev.type] || ev.type;
  top.appendChild(label);
  card.appendChild(top);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = fmtDate(ev.createdAt) + ' · IP: ' + ev.ip;
  card.appendChild(meta);

  if (ev.detail) {
    const detail = document.createElement('p');
    detail.className = 'link-meta';
    detail.textContent = ev.detail;
    card.appendChild(detail);
  }

  const actions = document.createElement('div');
  actions.className = 'link-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    if (await copyText(ev.ip)) toast('IP დაკოპირდა');
    else toast('კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);
  card.appendChild(actions);
  return card;
}

$('security-type-select').addEventListener('change', loadSecurityEvents);

$('security-clear-btn').addEventListener('click', async () => {
  if (!window.confirm('ნამდვილად გაასუფთავო უსაფრთხოების ლოგის მთლიანი სია? ეს მოქმედება უკან ვერ დაბრუნდება.')) return;
  try {
    const data = await api('/api/admin/security-events', { method: 'DELETE' });
    toast('გასუფთავდა: ' + (data.deleted || 0) + ' ჩანაწერი');
    loadSecurityEvents();
  } catch (e) { toast(e.message || 'შეცდომა'); }
});

/* ---------------- IP exclusions (v10.1) ---------------- */
// Admin-managed: visits from these IPs are never recorded.
let exclusions = [];

async function loadExclusions() {
  const err = $('exclusions-error');
  hideError(err);
  try {
    const data = await api('/api/admin/ip-exclusions');
    exclusions = data.exclusions || [];
    renderExclusions();
  } catch (e) {
    showError(err, e.message || 'გამონაკლისების ჩატვირთვა ვერ მოხერხდა.');
  }
}

function renderExclusions() {
  const list = $('exclusions-list');
  list.innerHTML = '';
  $('exclusions-empty').hidden = exclusions.length !== 0;
  for (const ex of exclusions) {
    list.appendChild(exclusionCard(ex));
  }
}

function exclusionCard(ex) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const top = document.createElement('div');
  top.className = 'link-top';
  const ip = document.createElement('span');
  ip.className = 'link-alias';
  ip.textContent = ex.ip;
  top.appendChild(ip);
  card.appendChild(top);

  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = 'დამატებულია: ' + fmtDate(ex.createdAt);
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small';
  copyBtn.type = 'button';
  copyBtn.textContent = 'კოპირება';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(ex.ip);
    toast(ok ? 'IP დაკოპირდა' : 'კოპირება ვერ მოხერხდა');
  });
  actions.appendChild(copyBtn);
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn small danger-outline';
  removeBtn.type = 'button';
  removeBtn.textContent = 'მოხსნა';
  removeBtn.addEventListener('click', async () => {
    try {
      await api('/api/admin/ip-exclusions?ip=' + encodeURIComponent(ex.ip), { method: 'DELETE' });
      toast('გამონაკლისი მოიხსნა');
      loadExclusions();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(removeBtn);
  card.appendChild(actions);
  return card;
}

$('exclusion-add-btn').addEventListener('click', async () => {
  const input = $('exclusion-ip-input');
  const ip = input.value.trim();
  if (!ip) { toast('IP მისამართი ჩაწერეთ'); return; }
  try {
    const data = await api('/api/admin/ip-exclusions', { method: 'POST', body: JSON.stringify({ ip }) });
    toast(data.added ? 'IP გამონაკლისებში დაემატა' : 'ეს IP უკვე გამონაკლისებშია');
    input.value = '';
    loadExclusions();
    loadVisitors();
  } catch (e) { toast(e.message || 'შეცდომა'); }
});

/* ---------------- Stats + activity ---------------- */
// Totals + activity feed are computed client-side from the already-loaded
// links and users — no extra API calls. The activity feed shows creations
// and registrations only (who + when). Per-click timestamps DO exist now
// (v3: click_events, link_id + clicked_at only) — they live in the
// "ბოლო გახსნები" block and in each link's history modal, loaded on demand.

// Custom period state (set from the date picker).
let customFrom = null; // epoch ms, start of day
let customTo = null;   // epoch ms, end of day

function periodRange() {
  const now = Date.now();
  if (activityPeriod === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: Infinity };
  }
  if (activityPeriod === '7d') return { from: now - 7 * 24 * 60 * 60 * 1000, to: Infinity };
  if (activityPeriod === '30d') return { from: now - 30 * 24 * 60 * 60 * 1000, to: Infinity };
  if (activityPeriod === 'custom' && customFrom !== null && customTo !== null) {
    return { from: customFrom, to: customTo };
  }
  return { from: 0, to: Infinity }; // all
}

function renderStats() {
  $('stat-links').textContent = String(links.length);
  $('stat-clicks').textContent = String(links.reduce((s, l) => s + (l.clicks || 0), 0));
  $('stat-users').textContent = String(users.length);
  $('stat-active-users').textContent = String(users.filter((u) => u.emailVerified && !u.disabled).length);
  $('stat-qr').textContent = String(qrFavs.length);

  const range = periodRange();
  const events = [];
  for (const link of links) {
    if (link.createdAt >= range.from && link.createdAt <= range.to) {
      events.push({
        ts: link.createdAt,
        who: link.owner || 'ანონიმური',
        text: 'ბმული შეიქმნა: ' + (link.note ? link.note + ' — ' : '') + link.shortUrl.replace(/^https?:\/\//, '') + ' → ' + link.destination,
      });
    }
  }
  for (const user of users) {
    if (user.createdAt >= range.from && user.createdAt <= range.to) {
      events.push({
        ts: user.createdAt,
        who: user.username,
        text: 'დარეგისტრირდა: ' + user.username + ' (' + user.email + ')',
      });
    }
  }
  for (const fav of qrFavs) {
    if (fav.createdAt >= range.from && fav.createdAt <= range.to) {
      events.push({
        ts: fav.createdAt,
        who: fav.owner || '—',
        text: 'QR რჩეული შეიქმნა: ' + fav.label + ' (' + (QR_TYPE_NAMES[fav.type] || fav.type) + ')',
      });
    }
  }
  events.sort((a, b) => b.ts - a.ts);
  const list = $('activity-list');
  list.innerHTML = '';
  $('activity-empty').hidden = events.length !== 0;
  for (const ev of events) {
    const item = document.createElement('div');
    item.className = 'link-card';
    const txt = document.createElement('p');
    txt.className = 'link-dest';
    txt.textContent = ev.text;
    item.appendChild(txt);
    const meta = document.createElement('p');
    meta.className = 'link-meta';
    meta.textContent = fmtDate(ev.ts) + ' · 👤 ' + ev.who;
    item.appendChild(meta);
    list.appendChild(item);
  }

  // Most popular links (admin only): top 5 by clicks, ties broken by
  // newest first. Computed from the already-loaded links — no API call.
  const top = links.slice().sort((a, b) =>
    (b.clicks || 0) - (a.clicks || 0) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  const topList = $('top-links-list');
  topList.innerHTML = '';
  $('top-links-empty').hidden = top.length !== 0;
  for (const link of top) {
    const item = document.createElement('div');
    item.className = 'link-card';
    const title = document.createElement('span');
    title.className = 'link-alias';
    title.textContent = link.note || link.shortUrl.replace(/^https?:\/\//, '');
    item.appendChild(title);
    const dest = document.createElement('p');
    dest.className = 'link-dest';
    dest.textContent = link.destination;
    item.appendChild(dest);
    const meta = document.createElement('p');
    meta.className = 'link-meta';
    meta.textContent = `👁 ${link.clicks} გახსნა`;
    item.appendChild(meta);
    topList.appendChild(item);
  }
}

/* ---------------- Click history (v3) ---------------- */

function clickRow(click) {
  const item = document.createElement('div');
  item.className = 'link-card';
  const alias = document.createElement('span');
  alias.className = 'link-alias';
  alias.textContent = click.note || click.shortUrl.replace(/^https?:\/\//, '');
  item.appendChild(alias);
  const dest = document.createElement('p');
  dest.className = 'link-dest';
  dest.textContent = click.destination;
  item.appendChild(dest);
  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = fmtDate(click.clickedAt);
  item.appendChild(meta);
  return item;
}

// Recent clicks across all links. Called only when the stats tab is opened
// (not inside renderStats, which runs on every links/users render).
async function loadRecentClicks() {
  const list = $('recent-clicks-list');
  try {
    const data = await api('/api/clicks/recent');
    const clicks = data.clicks || [];
    list.innerHTML = '';
    $('recent-clicks-empty').hidden = clicks.length !== 0;
    for (const click of clicks) list.appendChild(clickRow(click));
  } catch (e) {
    $('recent-clicks-empty').hidden = false;
    $('recent-clicks-empty').textContent = 'გახსნების ჩატვირთვა ვერ მოხერხდა.';
  }
}

// Per-link history modal. `events` hold only timestamps (v3) — clicks from
// before this feature have no timestamp, so the note explains the gap.
async function openHistory(link) {
  $('history-title').textContent = '🕘 ' + link.alias;
  $('history-count').textContent = `👁 ${link.clicks} გახსნა`;
  $('history-list').innerHTML = '';
  $('history-empty').hidden = true;
  $('history-modal').hidden = false;
  try {
    const data = await api('/api/links/' + link.id + '/clicks');
    const events = data.events || [];
    for (const ev of events) {
      const item = document.createElement('div');
      item.className = 'link-card';
      const txt = document.createElement('p');
      txt.className = 'link-dest';
      txt.textContent = 'გახსნილია: ' + fmtDate(ev.clickedAt);
      item.appendChild(txt);
      $('history-list').appendChild(item);
    }
    const empty = $('history-empty');
    if (link.clicks === 0) {
      empty.textContent = 'ამ ბმულს გახსნები ჯერ არ აქვს.';
      empty.hidden = false;
    } else if (events.length === 0) {
      empty.textContent = `ძველი გახსნები (ფუნქციის დამატებამდე) თარიღის გარეშეა — სულ ${link.clicks} გახსნა.`;
      empty.hidden = false;
    } else if (link.clicks > events.length) {
      empty.textContent = `კიდევ ${link.clicks - events.length} ძველი გახსნა თარიღის გარეშეა (ფუნქციის დამატებამდე).`;
      empty.hidden = false;
    }
  } catch (e) {
    const empty = $('history-empty');
    empty.textContent = 'ისტორიის ჩატვირთვა ვერ მოხერხდა.';
    empty.hidden = false;
  }
}

$('history-close').addEventListener('click', () => { $('history-modal').hidden = true; });
$('history-modal').addEventListener('click', (e) => {
  if (e.target === $('history-modal')) $('history-modal').hidden = true;
});

/* ---------------- Stat cards: open the matching view ---------------- */
// Links -> Links tab; Clicks -> recent-clicks block on this page;
// Users -> Users tab (all); Active users -> Users tab, active only;
// QR -> QR tab.
function openStatCard(target) {
  if (target === 'links') {
    showTab('links');
  } else if (target === 'clicks') {
    showTab('stats');
    setBelowView('recent');
    const h = $('below-tabs');
    if (h && h.scrollIntoView) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (target === 'users') {
    userFilter = 'all';
    showTab('users');
    renderUsers();
  } else if (target === 'active') {
    userFilter = 'active';
    showTab('users');
    renderUsers();
  } else if (target === 'qr') {
    showTab('qr');
  } else if (target === 'visitors') {
    showTab('visitors');
  }
}

const STAT_CARDS = {
  'stat-card-links': 'links',
  'stat-card-clicks': 'clicks',
  'stat-card-users': 'users',
  'stat-card-active': 'active',
  'stat-card-qr': 'qr',
  'stat-card-visitors': 'visitors',
};
for (const [id, target] of Object.entries(STAT_CARDS)) {
  const card = $(id);
  if (!card) continue;
  card.addEventListener('click', () => openStatCard(target));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStatCard(target); }
  });
}

/* ---------------- Stats lower blocks: popular / recent toggle -------- */
// Only one of the two blocks below is shown at a time.
let belowView = 'top';

function setBelowView(v) {
  belowView = v === 'recent' ? 'recent' : 'top';
  $('below-top-wrap').hidden = belowView !== 'top';
  $('below-recent-wrap').hidden = belowView !== 'recent';
  $('below-top').classList.toggle('active', belowView === 'top');
  $('below-recent').classList.toggle('active', belowView === 'recent');
}

$('below-top').addEventListener('click', () => setBelowView('top'));
$('below-recent').addEventListener('click', () => setBelowView('recent'));

const PERIODS = ['today', '7d', '30d', 'all'];

function setPeriodActive(p) {
  for (const q of PERIODS) $('period-' + q).classList.toggle('active', q === p);
  $('period-custom').classList.toggle('active', p === 'custom');
}

for (const p of PERIODS) {
  $('period-' + p).addEventListener('click', () => {
    activityPeriod = p;
    $('custom-period').hidden = true;
    setPeriodActive(p);
    renderStats();
  });
}

// Custom period: two date inputs + apply. Prefilled with the last 7 days.
$('period-custom').addEventListener('click', () => {
  const box = $('custom-period');
  box.hidden = !box.hidden;
  if (!box.hidden) {
    if (!$('custom-from').value) $('custom-from').value = dateInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    if (!$('custom-to').value) $('custom-to').value = dateInputValue(new Date());
  }
});

$('custom-apply').addEventListener('click', () => {
  const err = $('custom-error');
  err.hidden = true;
  const fromV = $('custom-from').value;
  const toV = $('custom-to').value;
  if (!fromV || !toV) {
    err.textContent = 'ორივე თარიღი შეიყვანეთ.';
    err.hidden = false;
    return;
  }
  const from = new Date(fromV + 'T00:00:00').getTime();
  const to = new Date(toV + 'T23:59:59.999').getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    err.textContent = 'საწყისი თარიღი საბოლოოზე გვიანი არ უნდა იყოს.';
    err.hidden = false;
    return;
  }
  activityPeriod = 'custom';
  customFrom = from;
  customTo = to;
  setPeriodActive('custom');
  renderStats();
});

function dateInputValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/* ---------------- Visit stats (v10.3): hours / pages / screens -------- */
let hoursPeriod = 'today';

async function loadVisitHours() {
  const err = $('hours-error');
  hideError(err);
  try {
    const data = await api('/api/admin/visit-hours?period=' + hoursPeriod);
    renderVisitHours(data.hours || []);
  } catch (e) {
    showError(err, e.message || 'საათების სტატისტიკა ვერ ჩაიტვირთა.');
  }
}

function renderVisitHours(hours) {
  const list = $('hours-list');
  list.innerHTML = '';
  const total = hours.reduce((sum, h) => sum + (h.visits || 0), 0);
  $('hours-empty').hidden = total !== 0;
  const max = Math.max(1, ...hours.map((h) => h.visits || 0));
  for (const h of hours) {
    const row = document.createElement('div');
    row.className = 'link-card';
    const label = document.createElement('span');
    label.className = 'link-alias';
    label.textContent = String(h.hour).padStart(2, '0') + ':00';
    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'height:10px;border-radius:999px;background:rgba(255,255,255,.08);margin:6px 0;overflow:hidden;';
    const bar = document.createElement('div');
    bar.style.cssText = 'height:100%;width:' + Math.round(((h.visits || 0) / max) * 100) + '%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:999px;';
    barWrap.appendChild(bar);
    const meta = document.createElement('p');
    meta.className = 'link-meta';
    meta.textContent = (h.visits || 0) + ' ვიზიტი';
    row.appendChild(label);
    row.appendChild(barWrap);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

const HOURS_BTNS = { 'hours-today': 'today', 'hours-7d': '7d', 'hours-30d': '30d', 'hours-90d': '90d' };
for (const [id, period] of Object.entries(HOURS_BTNS)) {
  $(id).addEventListener('click', () => {
    hoursPeriod = period;
    for (const [bid, p] of Object.entries(HOURS_BTNS)) $(bid).classList.toggle('active', p === period);
    loadVisitHours();
  });
}

async function loadPathStats() {
  const err = $('path-stats-error');
  hideError(err);
  try {
    const data = await api('/api/admin/path-stats');
    const list = $('path-stats-list');
    list.innerHTML = '';
    const pages = data.pages || [];
    $('path-stats-empty').hidden = pages.length !== 0;
    for (const pg of pages) {
      const card = document.createElement('div');
      card.className = 'link-card';
      const top = document.createElement('div');
      top.className = 'link-top';
      const name = document.createElement('span');
      name.className = 'link-alias';
      name.textContent = pg.path;
      top.appendChild(name);
      card.appendChild(top);
      const meta = document.createElement('p');
      meta.className = 'link-meta';
      meta.textContent = pg.visits + ' ვიზიტი · ბოლო: ' + fmtDate(pg.lastSeen);
      card.appendChild(meta);
      list.appendChild(card);
    }
  } catch (e) {
    showError(err, e.message || 'გვერდების სტატისტიკა ვერ ჩაიტვირთა.');
  }
}

async function loadScreenStats() {
  const err = $('screen-stats-error');
  hideError(err);
  try {
    const data = await api('/api/admin/screen-stats');
    const list = $('screen-stats-list');
    list.innerHTML = '';
    const screens = data.screens || [];
    $('screen-stats-empty').hidden = screens.length !== 0;
    for (const sc of screens) {
      const card = document.createElement('div');
      card.className = 'link-card';
      const top = document.createElement('div');
      top.className = 'link-top';
      const name = document.createElement('span');
      name.className = 'link-alias';
      name.textContent = sc.resolution;
      top.appendChild(name);
      card.appendChild(top);
      const meta = document.createElement('p');
      meta.className = 'link-meta';
      meta.textContent = sc.visits + ' ვიზიტი';
      card.appendChild(meta);
      list.appendChild(card);
    }
  } catch (e) {
    showError(err, e.message || 'ეკრანის სტატისტიკა ვერ ჩაიტვირთა.');
  }
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
  const note = $('note-input').value.trim();
  const expiryDate = $('expiry-input').value; // yyyy-mm-dd or ''
  let expiresAt = null;
  if (expiryDate) {
    const d = new Date(expiryDate + 'T23:59:59');
    expiresAt = d.getTime();
  }

  try {
    const data = await api('/api/links', {
      method: 'POST',
      body: JSON.stringify({ destination, alias: alias || undefined, note: note || undefined, expiresAt }),
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
    $('note-input').value = '';
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
let currentQrDownloadName = null;

function drawQr(canvas, text, size, opts) {
  // qrcode-generator (vendored in qrcode.min.js): 0 = auto type number.
  // opts: { fg, bg } — saved QR favorites keep their colors.
  opts = opts || {};
  const fg = opts.fg || '#000000';
  const bg = opts.bg || '#ffffff';
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
}

function openQr(link) {
  currentQrLink = link;
  currentQrDownloadName = link.alias;
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

// A saved QR favorite (v5): same modal, but the payload is the QR content
// (Wi-Fi string, tel:, text…) and the favorite's own colors are used.
function openQrFavorite(fav) {
  currentQrLink = null;
  currentQrDownloadName = (fav.label || 'qr').replace(/[^A-Za-z0-9ა-ჰ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'qr';
  $('qr-title').textContent = 'QR კოდი — ' + fav.label;
  $('qr-url').textContent = fav.payload;
  try {
    drawQr($('qr-canvas'), fav.payload, 256, { fg: fav.fg, bg: fav.bg });
  } catch (e) {
    toast('QR კოდის შექმნა ვერ მოხერხდა: შიგთავსი ძალიან გრძელია');
    return;
  }
  $('qr-modal').hidden = false;
}

$('qr-close').addEventListener('click', () => { $('qr-modal').hidden = true; });
$('qr-modal').addEventListener('click', (e) => {
  if (e.target === $('qr-modal')) $('qr-modal').hidden = true;
});

$('qr-download').addEventListener('click', () => {
  const name = currentQrDownloadName || (currentQrLink && currentQrLink.alias);
  if (!name) return;
  const canvas = $('qr-canvas');
  canvas.toBlob((blob) => {
    if (!blob) { toast('PNG შენახვა ვერ მოხერხდა'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name + '-qr.png';
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

/* ---------------- Admin chat (v7.0, redesigned in v7.1) ---------------- */
// 1:1 threads with email-verified users. The admin sends text + files
// (photos are compressed client-side before upload, max 5 MB — the
// server enforces the same cap; files live in the private R2 bucket). v7.1: the tab shows a list of ALL
// verified users; tapping a user opens the conversation (empty when
// there is no history yet). Opening a chat NEVER sends anything —
// the thread row is created lazily on the first explicit send. The
// "+" menu in the thread view sends a file, a link or a QR code, all
// only on an explicit tap. While the chat tab is open, the open
// thread (or the users list) refreshes every 5 seconds.
const CHAT_POLL_MS = 5000;
const CHAT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB, same as the server cap

let chatUsers = []; // verified users + thread summary, from /api/admin/chat/users
let chatOpenThreadId = null; // thread id, or null when the user has no thread yet
let chatOpenUserId = null; // user id of the open conversation
let chatOpenUsername = '';
let chatLastMessageId = 0;
let chatPollTimer = null;
let chatPendingAttachment = null; // { fileName, mimeType, dataBase64, sizeBytes }
let chatLoading = false;

function renderChatBadge() {
  const badge = $('chat-unread-badge');
  const total = chatUsers.reduce((s, u) => s + (u.adminUnread || 0), 0);
  badge.textContent = String(total);
  badge.hidden = total === 0;
}

async function loadChatUsers() {
  const err = $('chat-error');
  hideError(err);
  try {
    const data = await api('/api/admin/chat/users');
    chatUsers = data.users || [];
    renderChatUsers();
    renderChatBadge();
  } catch (e) {
    showError(err, e.message || 'მომხმარებლების ჩატვირთვა ვერ მოხერხდა.');
  }
}

function filteredChatUsers() {
  const q = ($('chat-users-search').value || '').trim().toLowerCase();
  if (!q) return chatUsers;
  return chatUsers.filter((u) =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q));
}

function renderChatUsers() {
  const list = $('chat-users-list');
  list.innerHTML = '';
  const shown = filteredChatUsers();
  const q = ($('chat-users-search').value || '').trim();
  $('chat-users-empty').hidden = shown.length !== 0;
  $('chat-users-empty').textContent = q ? 'მომხმარებელი ვერ მოიძებნა.' : 'დადასტურებული მომხმარებელი არ არის.';
  for (const u of shown) list.appendChild(chatUserRow(u));
}

$('chat-users-search').addEventListener('input', renderChatUsers);

function chatUserRow(u) {
  const card = document.createElement('div');
  card.className = 'link-card chat-user-row';
  const top = document.createElement('div');
  top.className = 'link-top';
  const name = document.createElement('span');
  name.className = 'link-alias';
  name.textContent = u.username;
  top.appendChild(name);
  if (u.adminUnread > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge unread';
    badge.textContent = String(u.adminUnread);
    top.appendChild(badge);
  }
  card.appendChild(top);
  if (u.lastBody) {
    const prev = document.createElement('p');
    prev.className = 'chat-preview';
    prev.textContent = (u.lastSender === 'admin' ? 'შენ: ' : '') + u.lastBody.slice(0, 120);
    card.appendChild(prev);
  }
  const meta = document.createElement('p');
  meta.className = 'link-meta';
  meta.textContent = u.email + (u.threadId ? ' · ' + fmtDate(u.lastMessageAt) : ' · ჩატი ჯერ არ არის');
  card.appendChild(meta);
  card.addEventListener('click', () => openChatUser(u));
  return card;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// LINKIFY-START
// Splits plain message text into [{ text }] and [{ url }] segments so
// URLs render as clickable links. PURE function: no DOM use, no side
// effects — the test harness extracts and tests it in isolation.
// Only http:// and https:// URLs become links; javascript:/data: and
// friends never do. Trailing punctuation (.,;:!?) and unbalanced
// closing brackets are excluded from the URL. NOTE: an identical
// copy lives in the other chat file (app.js and auth.js) — keep the
// two in sync.
function linkifySegments(text) {
  const segments = [];
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    let cut = raw.length;
    while (cut > 0 && '.,;:!?'.includes(raw[cut - 1])) cut--;
    // Strip unbalanced closing brackets: "(https://x.example/)" loses
    // the ")" but "https://x.example/wiki/A_(B)" keeps its own.
    const pairs = { ')': '(', ']': '[', '}': '{' };
    while (cut > 0 && pairs[raw[cut - 1]]) {
      const close = raw[cut - 1];
      const open = pairs[close];
      const body = raw.slice(0, cut - 1); // exclude the bracket itself
      let depth = 0;
      for (const ch of body) {
        if (ch === open) depth++;
        else if (ch === close) depth--;
      }
      if (depth > 0) break; // balanced — the bracket belongs to the URL
      cut--;
    }
    let url = raw.slice(0, cut);
    const tail = raw.slice(cut);
    // Degenerate match ("https://" with nothing after it) stays text.
    if (!/^https?:\/\/[^/]/.test(url)) url = '';
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    if (url) {
      segments.push({ url });
      if (tail) segments.push({ text: tail });
    } else {
      segments.push({ text: raw });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}
// LINKIFY-END

// Renders a message body into `parent`: plain text stays text, URLs
// become <a> links. Built with the DOM API only — user text is never
// inserted as HTML, so no markup (or script) can break out.
function appendLinkifiedText(parent, text) {
  for (const seg of linkifySegments(text)) {
    if (seg.url) {
      const a = document.createElement('a');
      a.href = seg.url;
      a.textContent = seg.url;
      a.target = '_blank';
      a.rel = 'noopener';
      parent.appendChild(a);
    } else {
      parent.appendChild(document.createTextNode(seg.text));
    }
  }
}

function chatMessageEl(msg, mine) {
  const el = document.createElement('div');
  el.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
  if (msg.body) {
    const p = document.createElement('div');
    appendLinkifiedText(p, msg.body);
    el.appendChild(p);
  }
  if (msg.attachment) {
    const att = msg.attachment;
    if (att.mimeType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = att.url;
      img.alt = att.fileName;
      img.loading = 'lazy';
      el.appendChild(img);
    }
    const a = document.createElement('a');
    a.className = 'chat-file';
    a.href = att.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '📎 ' + att.fileName + ' (' + formatBytes(att.sizeBytes) + ')';
    el.appendChild(a);
  }
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = fmtDate(msg.createdAt);
  el.appendChild(meta);
  return el;
}

function appendChatMessage(msg) {
  $('chat-messages').appendChild(chatMessageEl(msg, msg.sender === 'admin'));
  $('chat-thread-empty').hidden = true;
}

function scrollChatToBottom(force) {
  const box = $('chat-messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// Opening a conversation is read-only: it fetches messages when a
// thread exists and shows an empty view otherwise. It NEVER sends
// anything and never creates a thread row.
async function openChatUser(u) {
  chatOpenThreadId = u.threadId || null;
  chatOpenUserId = u.id;
  chatOpenUsername = u.username;
  chatLastMessageId = 0;
  $('chat-users-view').hidden = true;
  $('chat-thread-view').hidden = false;
  $('chat-thread-title').textContent = '💬 ' + chatOpenUsername;
  $('chat-messages').innerHTML = '';
  $('chat-thread-empty').hidden = false;
  $('chat-input').value = '';
  clearChatAttachment();
  hideError($('chat-thread-error'));
  $('chat-delete-btn').hidden = !chatOpenThreadId;
  if (chatOpenThreadId) await refreshChatThread(true);
}

// While an empty conversation is open, the user may write first —
// their message creates the thread server-side. The poll picks the
// new thread up and loads its messages.
async function adoptThreadIfCreated() {
  if (chatOpenThreadId || !chatOpenUserId || chatLoading) return;
  try {
    const data = await api('/api/admin/chat/users');
    chatUsers = data.users || [];
    renderChatUsers();
    renderChatBadge();
    const u = chatUsers.find((x) => x.id === chatOpenUserId);
    if (u && u.threadId) {
      chatOpenThreadId = u.threadId;
      $('chat-delete-btn').hidden = false;
      await refreshChatThread(true);
    }
  } catch { /* the next poll retries */ }
}

async function refreshChatThread(first) {
  if (!chatOpenThreadId || chatLoading) return;
  chatLoading = true;
  try {
    const data = await api('/api/admin/chat/threads/' + chatOpenThreadId + (chatLastMessageId ? '?after=' + chatLastMessageId : ''));
    const messages = data.messages || [];
    for (const m of messages) {
      appendChatMessage(m);
      chatLastMessageId = Math.max(chatLastMessageId, m.id);
    }
    if (messages.length) scrollChatToBottom(false);
    if (data.thread && data.thread.adminUnread > 0) {
      await api('/api/admin/chat/threads/' + chatOpenThreadId + '/read', { method: 'POST', body: '{}' });
      const u = chatUsers.find((x) => x.threadId === chatOpenThreadId);
      if (u) u.adminUnread = 0;
      renderChatBadge();
    }
  } catch (e) {
    if (first) showError($('chat-thread-error'), e.message || 'ჩატის ჩატვირთვა ვერ მოხერხდა.');
  } finally {
    chatLoading = false;
  }
}

function startChatPolling() {
  stopChatPolling();
  chatPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (currentTab !== 'chat') return;
    if (chatOpenThreadId) refreshChatThread(false);
    else if (chatOpenUserId) adoptThreadIfCreated();
    else loadChatUsers();
  }, CHAT_POLL_MS);
}

function stopChatPolling() {
  if (chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = null;
}

// Creates the empty thread row on the first explicit send (never on
// open). Returns the thread id.
async function ensureChatThread() {
  if (chatOpenThreadId) return chatOpenThreadId;
  if (!chatOpenUserId) throw new Error('მომხმარებელი არ არის არჩეული.');
  const created = await api('/api/admin/chat/threads', {
    method: 'POST',
    body: JSON.stringify({ userId: chatOpenUserId }),
  });
  chatOpenThreadId = created.threadId;
  $('chat-delete-btn').hidden = false;
  return chatOpenThreadId;
}

// Sends one message (text, attachment and/or link — the server
// enforces which combinations are valid) and appends it to the open
// conversation. Used by the send button and by the "+" menu.
async function sendChatPayload(payload) {
  const threadId = await ensureChatThread();
  const data = await api('/api/admin/chat/threads/' + threadId + '/send', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  appendChatMessage(data.message);
  chatLastMessageId = Math.max(chatLastMessageId, data.message.id);
  scrollChatToBottom(true);
  loadChatUsers(); // refresh the users list in the background
  return data;
}

async function sendChatMessage() {
  const btn = $('chat-send-btn');
  const err = $('chat-thread-error');
  hideError(err);
  const body = $('chat-input').value.trim();
  if (!body && !chatPendingAttachment) {
    showError(err, 'შეტყობინება დაწერეთ ან ფაილი აირჩიეთ.');
    return;
  }
  btn.disabled = true;
  try {
    await sendChatPayload({ body, attachment: chatPendingAttachment || undefined });
    $('chat-input').value = '';
    clearChatAttachment();
  } catch (e) {
    showError(err, e.message || 'გაგზავნა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
}

$('chat-send-btn').addEventListener('click', sendChatMessage);

$('chat-back-btn').addEventListener('click', () => {
  chatOpenThreadId = null;
  chatOpenUserId = null;
  $('chat-thread-view').hidden = true;
  $('chat-users-view').hidden = false;
  loadChatUsers();
});

$('chat-delete-btn').addEventListener('click', async () => {
  if (!chatOpenThreadId) return;
  if (!window.confirm('ნამდვილად წავშალო ჩატი „' + chatOpenUsername + '"-თან? ყველა შეტყობინება და ფაილი წაიშლება.')) return;
  try {
    await api('/api/admin/chat/threads/' + chatOpenThreadId, { method: 'DELETE' });
    toast('ჩატი წაიშალა');
    chatOpenThreadId = null;
    chatOpenUserId = null;
    $('chat-thread-view').hidden = true;
    $('chat-users-view').hidden = false;
    loadChatUsers();
  } catch (e) { toast(e.message || 'შეცდომა'); }
});

/* ---------------- Chat attachments (client-side) ---------------- */

const CHAT_CLIENT_ALLOWED = {
  'image/png': true, 'image/jpeg': true, 'image/gif': true, 'image/webp': true,
  'application/pdf': true, 'text/plain': true, 'application/zip': true,
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('ფაილის წაკითხვა ვერ მოხერხდა.'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('სურათის ჩატვირთვა ვერ მოხერხდა.'));
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('სურათის დამუშავება ვერ მოხერხდა.'));
    }, type, quality);
  });
}

// Photos are compressed client-side (max side 1600px, JPEG ~0.85) so a
// phone photo fits the 5 MB server cap. GIFs keep animation (no
// recompress); PDFs, text and ZIP pass through unchanged.
async function prepareChatAttachment(file) {
  const mime = (file.type || '').toLowerCase();
  if (!CHAT_CLIENT_ALLOWED[mime]) {
    throw new Error('ფაილის ტიპი დაუშვებელია — სურათი, PDF, ტექსტი ან ZIP შეიძლება.');
  }
  let blob = file;
  let outMime = mime;
  let outName = file.name;
  if ((mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') && file.size > 300 * 1024) {
    const dataUrl = await readFileAsDataUrl(file);
    const img = await loadImageElement(dataUrl);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
    outMime = 'image/jpeg';
    outName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  }
  if (blob.size > CHAT_MAX_ATTACHMENT_BYTES) {
    throw new Error('ფაილი ძალიან დიდია (მაქს. 5 MB).');
  }
  const dataUrl = await readFileAsDataUrl(blob);
  const base64 = String(dataUrl).split(',')[1] || '';
  return { fileName: outName, mimeType: outMime, dataBase64: base64, sizeBytes: blob.size };
}

function clearChatAttachment() {
  chatPendingAttachment = null;
  $('chat-file-input').value = '';
  $('chat-attach-line').hidden = true;
  $('chat-attach-name').textContent = '';
}

$('chat-attach-clear').addEventListener('click', clearChatAttachment);

$('chat-file-input').addEventListener('change', async () => {
  const file = $('chat-file-input').files && $('chat-file-input').files[0];
  if (!file) return;
  const err = $('chat-thread-error');
  hideError(err);
  try {
    chatPendingAttachment = await prepareChatAttachment(file);
    $('chat-attach-name').textContent = chatPendingAttachment.fileName + ' (' + formatBytes(chatPendingAttachment.sizeBytes) + ')';
    $('chat-attach-line').hidden = false;
  } catch (e) {
    clearChatAttachment();
    showError(err, e.message || 'ფაილის მომზადება ვერ მოხერხდა.');
  }
});

/* ---------------- Chat "+" menu (v7.1) ---------------- */
// Inside an open thread, the "+" button offers three manual actions —
// a file, a link or a QR code. Nothing is sent until the admin taps
// an item (or the send button); opening any picker sends nothing.
let chatPlusSending = false; // guards the pickers against double taps

function openChatPlusMenu() { $('chat-plus-modal').hidden = false; }
function closeChatPlusMenu() { $('chat-plus-modal').hidden = true; }

$('chat-plus-btn').addEventListener('click', openChatPlusMenu);
$('chat-plus-close').addEventListener('click', closeChatPlusMenu);
$('chat-plus-modal').addEventListener('click', (e) => {
  if (e.target === $('chat-plus-modal')) closeChatPlusMenu();
});
$('chat-plus-file').addEventListener('click', () => {
  closeChatPlusMenu();
  $('chat-file-input').click();
});
$('chat-plus-link').addEventListener('click', async () => {
  closeChatPlusMenu();
  await openChatLinkModal();
});
$('chat-plus-qr').addEventListener('click', async () => {
  closeChatPlusMenu();
  await openChatQrModal();
});

/* ----- Link picker: own short links, or any https URL ----- */

function validateChatLinkClient(value) {
  if (!value) return { ok: false, reason: 'ლინკი ჩაწერეთ.' };
  if (value.length > 2000) return { ok: false, reason: 'ლინკი ძალიან გრძელია.' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'ლინკი არასწორია — სრული https მისამართი ჩაწერეთ.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'მხოლოდ https ლინკი შეიძლება.' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'ლინკში მომხმარებლის სახელი/პაროლი არ შეიძლება.' };
  return { ok: true };
}

async function openChatLinkModal() {
  const err = $('chat-link-error');
  hideError(err);
  $('chat-link-url').value = '';
  $('chat-link-modal').hidden = false;
  const listEl = $('chat-link-list');
  listEl.innerHTML = '';
  $('chat-link-empty').hidden = true;
  try {
    const data = await api('/api/links');
    links = data.links || [];
    if (links.length === 0) {
      $('chat-link-empty').hidden = false;
      return;
    }
    for (const link of links) {
      const row = document.createElement('div');
      row.className = 'link-card picker-row';
      const title = document.createElement('p');
      title.className = 'link-note';
      title.textContent = link.note || link.shortUrl.replace(/^https?:\/\//, '');
      row.appendChild(title);
      const dest = document.createElement('p');
      dest.className = 'link-dest';
      dest.textContent = link.shortUrl + ' → ' + link.destination;
      row.appendChild(dest);
      row.addEventListener('click', () => sendChatLink(link.shortUrl));
      listEl.appendChild(row);
    }
  } catch (e) {
    showError(err, e.message || 'ბმულების ჩატვირთვა ვერ მოხერხდა.');
  }
}

async function sendChatLink(url) {
  if (chatPlusSending) return;
  chatPlusSending = true;
  try {
    await sendChatPayload({ linkUrl: url });
    $('chat-link-modal').hidden = true;
    toast('ლინკი გაიგზავნა');
  } catch (e) {
    showError($('chat-link-error'), e.message || 'გაგზავნა ვერ მოხერხდა.');
  } finally {
    chatPlusSending = false;
  }
}

$('chat-link-send').addEventListener('click', async () => {
  const value = $('chat-link-url').value.trim();
  const err = $('chat-link-error');
  hideError(err);
  const validation = validateChatLinkClient(value);
  if (!validation.ok) {
    showError(err, validation.reason);
    return;
  }
  await sendChatLink(value);
});
$('chat-link-close').addEventListener('click', () => { $('chat-link-modal').hidden = true; });
$('chat-link-modal').addEventListener('click', (e) => {
  if (e.target === $('chat-link-modal')) $('chat-link-modal').hidden = true;
});

/* ----- QR picker: QR codes from the QR tab's history ----- */

async function openChatQrModal() {
  const err = $('chat-qr-error');
  hideError(err);
  $('chat-qr-modal').hidden = false;
  const listEl = $('chat-qr-list');
  listEl.innerHTML = '';
  $('chat-qr-empty').hidden = true;
  try {
    if (!qrFavLoaded) await loadQrFavoritesAdmin();
    if (qrFavs.length === 0) {
      $('chat-qr-empty').hidden = false;
      return;
    }
    for (const fav of qrFavs) {
      const row = document.createElement('div');
      row.className = 'link-card picker-row';
      const title = document.createElement('p');
      title.className = 'link-note';
      title.textContent = fav.label;
      row.appendChild(title);
      const top = document.createElement('div');
      top.className = 'link-top';
      const type = document.createElement('span');
      type.className = 'link-alias';
      type.textContent = QR_TYPE_NAMES[fav.type] || fav.type;
      top.appendChild(type);
      const badge = document.createElement('span');
      badge.className = 'badge type';
      badge.textContent = '👤 ' + (fav.owner || 'ანონიმური');
      top.appendChild(badge);
      row.appendChild(top);
      const payload = document.createElement('p');
      payload.className = 'fav-payload';
      payload.textContent = fav.payload;
      row.appendChild(payload);
      row.addEventListener('click', () => sendChatQr(fav));
      listEl.appendChild(row);
    }
  } catch (e) {
    showError(err, e.message || 'QR კოდების ჩატვირთვა ვერ მოხერხდა.');
  }
}

async function sendChatQr(fav) {
  if (chatPlusSending) return;
  chatPlusSending = true;
  try {
    // Same 512px render as the QR tab's PNG download; QR PNGs are
    // tiny, so no compression step is needed.
    const canvas = document.createElement('canvas');
    drawQr(canvas, fav.payload, 512, { fg: fav.fg, bg: fav.bg });
    const blob = await canvasToBlob(canvas, 'image/png');
    if (blob.size > CHAT_MAX_ATTACHMENT_BYTES) throw new Error('QR ფაილი ძალიან დიდია.');
    const dataUrl = await readFileAsDataUrl(blob);
    const base64 = String(dataUrl).split(',')[1] || '';
    const name = (fav.label || 'qr').replace(/[^A-Za-z0-9ა-ჰ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'qr';
    await sendChatPayload({
      body: '',
      attachment: { fileName: name + '-qr.png', mimeType: 'image/png', dataBase64: base64 },
    });
    $('chat-qr-modal').hidden = true;
    toast('QR კოდი გაიგზავნა');
  } catch (e) {
    showError($('chat-qr-error'), e.message || 'გაგზავნა ვერ მოხერხდა.');
  } finally {
    chatPlusSending = false;
  }
}

$('chat-qr-close').addEventListener('click', () => { $('chat-qr-modal').hidden = true; });
$('chat-qr-modal').addEventListener('click', (e) => {
  if (e.target === $('chat-qr-modal')) $('chat-qr-modal').hidden = true;
});

/* ---------------- Start ---------------- */

checkAuth();

// Open the tab from the URL hash (#links / #users / #create / #stats).
let startTab = 'links';
try {
  const h = (window.location.hash || '').slice(1);
  if (TABS.includes(h)) startTab = h;
} catch { /* ignore */ }
showTab(startTab);
