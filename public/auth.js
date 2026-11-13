/* Mini Link — user accounts on the public site (v2).
   Accounts are voluntary: the shorten form works without any login, and
   logged-in users get their links saved in "ჩემი ბმულები".
   Depends on public.js globals: toast, showError, hideError, copyText,
   openQr (QR modal). public.js must load BEFORE this file. */
'use strict';

const el = (id) => document.getElementById(id);

let authUser = null;
let authMyLinks = [];
let authPendingEmail = '';
let authSearchTimer = null;

// Profile state (v8.0): the logged-in user's public page at /@username.
// myProfile is null until loaded, or when the user has no profile yet.
let myProfile = null;
let profileLoaded = false;
let profileAddMode = 'short'; // 'short' | 'manual'
let profileLinkEditingId = null;
let profileAvatarBusy = false;

async function authApi(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('შეცდომა: ' + res.status));
    err.data = data;
    throw err;
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

/* ---------------- UI state ---------------- */

const AUTH_FORMS = ['form-login', 'form-register', 'form-verify', 'form-forgot', 'form-reset'];

function showAuthForm(name) {
  el('auth-card').hidden = false;
  for (const id of AUTH_FORMS) el(id).hidden = id !== name;
}

function hideAuthCard() {
  el('auth-card').hidden = true;
  for (const id of AUTH_FORMS) el(id).hidden = true;
}

function setLoggedIn(user) {
  authUser = user;
  el('auth-logged-out').hidden = true;
  el('user-name').textContent = user ? user.username : '';
  el('my-links-card').hidden = false;
  hideAuthCard();
  if (user) loadMyLinks();
  // v7.0: the admin chat is shown ONLY to email-verified users (the
  // server enforces the same gate on every chat route).
  const showChat = !!(user && user.emailVerified);
  el('chat-card').hidden = !showChat;
  if (showChat) startUserChat();
  else stopUserChat();
  // v8.0: logged-in navigation (top bar) + profile editor.
  if (user) {
    el('user-topbar').hidden = false;
    updateNavMenu();
    loadMyProfile();
  }
  // v5: QR favorites switch to the server list when logged in.
  if (typeof loadQrFavorites === 'function') loadQrFavorites();
}

function setLoggedOut() {
  authUser = null;
  authMyLinks = [];
  el('auth-logged-out').hidden = false;
  el('my-links-card').hidden = true;
  el('chat-card').hidden = true;
  stopUserChat();
  // v8.0: hide the navigation + profile UI and drop profile state.
  el('user-topbar').hidden = true;
  el('nav-menu').hidden = true;
  el('profile-card').hidden = true;
  el('settings-modal').hidden = true;
  myProfile = null;
  profileLoaded = false;
  profileLinkEditingId = null;
  hideError(el('profile-error'));
  renderMyLinks();
  // v5: QR favorites fall back to this device's localStorage list.
  if (typeof loadQrFavorites === 'function') loadQrFavorites();
}

// v5: public.js asks this to decide where QR favorites live
// (server when logged in, localStorage when anonymous).
function isUserLoggedIn() {
  return !!authUser;
}

async function checkUserAuth() {
  try {
    const data = await authApi('/api/auth/me');
    setLoggedIn(data.user);
  } catch {
    setLoggedOut();
  }
}

/* ---------------- Verify screen ---------------- */

function showVerify(email, mailWarning) {
  authPendingEmail = email;
  el('verify-email-label').textContent = email;
  const warn = el('verify-mail-warning');
  if (mailWarning) {
    warn.textContent = mailWarning;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  hideError(el('verify-error'));
  el('verify-code').value = '';
  showAuthForm('form-verify');
}

/* ---------------- Forms ---------------- */

el('login-open-btn').addEventListener('click', () => {
  hideError(el('login-auth-error'));
  showAuthForm('form-login');
});
el('register-open-btn').addEventListener('click', () => {
  hideError(el('register-error'));
  showAuthForm('form-register');
});
el('to-register-btn').addEventListener('click', () => showAuthForm('form-register'));
el('to-login-btn').addEventListener('click', () => showAuthForm('form-login'));
el('to-login-btn2').addEventListener('click', () => showAuthForm('form-login'));
el('to-forgot-btn').addEventListener('click', () => showAuthForm('form-forgot'));
el('auth-close-btn').addEventListener('click', hideAuthCard);

el('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('login-submit-btn');
  const err = el('login-auth-error');
  hideError(err);
  btn.disabled = true;
  try {
    const data = await authApi('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login: el('login-id').value.trim(), password: el('login-pass').value }),
    });
    el('login-pass').value = '';
    toast('შესვლა წარმატებულია');
    setLoggedIn(data.user);
  } catch (e2) {
    if (e2.data && e2.data.error === 'email_not_verified' && e2.data.email) {
      toast('მეილი ჯერ არ არის დადასტურებული — კოდი შეიყვანეთ');
      showVerify(e2.data.email, '');
    } else {
      showError(err, e2.message || 'შესვლა ვერ მოხერხდა.');
    }
  } finally {
    btn.disabled = false;
  }
});

el('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('register-submit-btn');
  const err = el('register-error');
  hideError(err);
  btn.disabled = true;
  try {
    const data = await authApi('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: el('reg-username').value.trim(),
        email: el('reg-email').value.trim(),
        password: el('reg-password').value,
      }),
    });
    el('reg-password').value = '';
    toast('რეგისტრაცია წარმატებულია — კოდი მეილზე გაიგზავნა');
    const warning = data.emailSent === false
      ? 'ვერიფიკაციის მეილი ვერ გაიგზავნა (მეილის გაგზავნა ჯერ არ არის დაყენებული) — სცადეთ კოდის ხელახლა გაგზავნა მოგვიანებით.'
      : '';
    showVerify(data.user.email, warning);
  } catch (e2) {
    showError(err, e2.message || 'რეგისტრაცია ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

el('form-verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('verify-submit-btn');
  const err = el('verify-error');
  hideError(err);
  btn.disabled = true;
  try {
    const data = await authApi('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ email: authPendingEmail, code: el('verify-code').value.trim() }),
    });
    toast('მეილი დადასტურდა');
    setLoggedIn(data.user);
  } catch (e2) {
    showError(err, e2.message || 'დადასტურება ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

el('resend-code-btn').addEventListener('click', async () => {
  const err = el('verify-error');
  hideError(err);
  try {
    const data = await authApi('/api/auth/resend-code', {
      method: 'POST',
      body: JSON.stringify({ email: authPendingEmail, purpose: 'verify' }),
    });
    if (data && data.error === 'email_not_configured') {
      showError(err, 'ვერიფიკაციის მეილი ვერ გაიგზავნა — მეილის გაგზავნა ჯერ არ არის დაყენებული. სცადეთ მოგვიანებით.');
    } else if (data && data.alreadyVerified) {
      toast('მეილი უკვე დადასტურებულია');
      checkUserAuth();
    } else {
      toast('კოდი ხელახლა გაიგზავნა');
    }
  } catch (e2) {
    showError(err, e2.message || 'კოდის გაგზავნა ვერ მოხერხდა.');
  }
});

el('form-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('forgot-submit-btn');
  const err = el('forgot-error');
  hideError(err);
  btn.disabled = true;
  try {
    const email = el('forgot-email').value.trim();
    await authApi('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    authPendingEmail = email;
    el('reset-email-label').textContent = email;
    hideError(el('reset-error'));
    el('reset-code').value = '';
    el('reset-password').value = '';
    showAuthForm('form-reset');
    toast('თუ ასეთი მეილი არსებობს, კოდი გაიგზავნა');
  } catch (e2) {
    showError(err, e2.message || 'კოდის გაგზავნა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

el('form-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('reset-submit-btn');
  const err = el('reset-error');
  hideError(err);
  btn.disabled = true;
  try {
    const data = await authApi('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        email: authPendingEmail,
        code: el('reset-code').value.trim(),
        new_password: el('reset-password').value,
      }),
    });
    toast('პაროლი შეიცვალა');
    setLoggedIn(data.user);
  } catch (e2) {
    showError(err, e2.message || 'პაროლის შეცვლა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

el('resend-reset-code-btn').addEventListener('click', async () => {
  const err = el('reset-error');
  hideError(err);
  try {
    const data = await authApi('/api/auth/resend-code', {
      method: 'POST',
      body: JSON.stringify({ email: authPendingEmail, purpose: 'reset' }),
    });
    if (data && data.error === 'email_not_configured') {
      showError(err, 'კოდის გაგზავნა ვერ მოხერხდა — მეილის გაგზავნა ჯერ არ არის დაყენებული. სცადეთ მოგვიანებით.');
    } else {
      toast('კოდი ხელახლა გაიგზავნა');
    }
  } catch (e2) {
    showError(err, e2.message || 'კოდის გაგზავნა ვერ მოხერხდა.');
  }
});

el('user-logout-btn').addEventListener('click', async () => {
  try { await authApi('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  setLoggedOut();
  toast('გასული ხართ');
});

/* ---------------- My links ---------------- */

async function loadMyLinks() {
  const err = el('my-links-error');
  hideError(err);
  try {
    const data = await authApi('/api/auth/links');
    authMyLinks = data.links || [];
    renderMyLinks();
  } catch (e) {
    showError(err, e.message || 'ბმულების ჩატვირთვა ვერ მოხერხდა.');
  }
  // Recent clicks across the user's own links — a separate call, so a
  // failure here never breaks the links list above.
  try {
    const data = await authApi('/api/auth/clicks/recent');
    renderMyRecentClicks(data.clicks || []);
  } catch {
    el('my-recent-clicks-empty').hidden = false;
    el('my-recent-clicks-empty').textContent = 'გახსნების ჩატვირთვა ვერ მოხერხდა.';
  }
}

function renderMyRecentClicks(clicks) {
  const list = el('my-recent-clicks-list');
  list.innerHTML = '';
  el('my-recent-clicks-empty').hidden = clicks.length !== 0;
  if (clicks.length === 0) el('my-recent-clicks-empty').textContent = 'გახსნები ჯერ არ არის.';
  for (const click of clicks) {
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
    list.appendChild(item);
  }
}

/* ---------------- Click history (v3) ---------------- */

// Per-link history modal. `events` hold only timestamps (v3) — clicks from
// before this feature have no timestamp, so the note explains the gap.
async function openMyHistory(link) {
  el('history-title').textContent = '🕘 ' + link.alias;
  el('history-count').textContent = `👁 ${link.clicks} გახსნა`;
  el('history-list').innerHTML = '';
  el('history-empty').hidden = true;
  el('history-modal').hidden = false;
  try {
    const data = await authApi('/api/auth/links/' + link.id + '/clicks');
    const events = data.events || [];
    for (const ev of events) {
      const item = document.createElement('div');
      item.className = 'link-card';
      const txt = document.createElement('p');
      txt.className = 'link-dest';
      txt.textContent = 'გახსნილია: ' + fmtDate(ev.clickedAt);
      item.appendChild(txt);
      el('history-list').appendChild(item);
    }
    const empty = el('history-empty');
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
    const empty = el('history-empty');
    empty.textContent = 'ისტორიის ჩატვირთვა ვერ მოხერხდა.';
    empty.hidden = false;
  }
}

el('history-close').addEventListener('click', () => { el('history-modal').hidden = true; });
el('history-modal').addEventListener('click', (e) => {
  if (e.target === el('history-modal')) el('history-modal').hidden = true;
});

function renderMyLinks() {
  const list = el('my-links-list');
  const q = el('my-search-input').value.trim().toLowerCase();
  list.innerHTML = '';
  const shown = authMyLinks.filter((l) =>
    !q || l.alias.toLowerCase().includes(q) || l.destination.toLowerCase().includes(q) ||
    (l.note || '').toLowerCase().includes(q));
  el('my-links-empty').hidden = shown.length !== 0;
  for (const link of shown) list.appendChild(myLinkCard(link));
}

/* ---------------- Link note (edit modal) ---------------- */

let currentNoteLink = null;

function openMyNoteModal(link) {
  currentNoteLink = link;
  el('note-modal-input').value = link.note || '';
  el('note-modal').hidden = false;
}

el('note-modal-save').addEventListener('click', async () => {
  if (!currentNoteLink) return;
  try {
    await authApi('/api/auth/links/' + currentNoteLink.id, {
      method: 'PATCH',
      body: JSON.stringify({ note: el('note-modal-input').value }),
    });
    el('note-modal').hidden = true;
    toast('შენიშვნა შენახულია');
    loadMyLinks();
  } catch (e) { toast(e.message || 'შეცდომა'); }
});
el('note-modal-close').addEventListener('click', () => { el('note-modal').hidden = true; });
el('note-modal').addEventListener('click', (e) => {
  if (e.target === el('note-modal')) el('note-modal').hidden = true;
});

function myLinkCard(link) {
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
  meta.textContent = `👁 ${link.clicks} გახსნა · შექმნილია: ${fmtDate(link.createdAt)} · ვადა: ${fmtExpiry(link.expiresAt)}`;
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
  historyBtn.addEventListener('click', () => openMyHistory(link));
  actions.appendChild(historyBtn);

  const noteBtn = document.createElement('button');
  noteBtn.className = 'btn small';
  noteBtn.textContent = '✏️ შენიშვნა';
  noteBtn.addEventListener('click', () => openMyNoteModal(link));
  actions.appendChild(noteBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn small';
  toggleBtn.textContent = link.enabled ? 'გამორთვა' : 'ჩართვა';
  toggleBtn.addEventListener('click', async () => {
    try {
      await authApi('/api/auth/links/' + link.id, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !link.enabled }),
      });
      toast(link.enabled ? 'ბმული გამორთულია' : 'ბმული ჩართულია');
      loadMyLinks();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(toggleBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm('ნამდვილად წავშალო ბმული „' + link.alias + '"?')) return;
    try {
      await authApi('/api/auth/links/' + link.id, { method: 'DELETE' });
      toast('ბმული წაიშალა');
      loadMyLinks();
    } catch (e) { toast(e.message || 'შეცდომა'); }
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);
  card.appendChild(shareButtons(link));
  return card;
}

el('my-search-input').addEventListener('input', () => {
  clearTimeout(authSearchTimer);
  authSearchTimer = setTimeout(renderMyLinks, 250);
});

/* ---------------- Admin chat (v7.0) ---------------- */
// Visible ONLY to logged-in, email-verified users (the server enforces
// the same gate on every chat route). Users send TEXT only; the admin
// may also send photos and files, which render inline here. New
// messages arrive by polling every 5 seconds while the page is open.
const USER_CHAT_POLL_MS = 5000;

let userChatLastId = 0;
let userChatPollTimer = null;
let userChatLoading = false;
let userChatObserver = null;

function userChatFormatBytes(n) {
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

function userChatMessageEl(msg) {
  const mine = msg.sender === 'user';
  const box = document.createElement('div');
  box.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
  if (msg.body) {
    const p = document.createElement('div');
    appendLinkifiedText(p, msg.body);
    box.appendChild(p);
  }
  if (msg.attachment) {
    const att = msg.attachment;
    if (att.mimeType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = att.url;
      img.alt = att.fileName;
      img.loading = 'lazy';
      box.appendChild(img);
    }
    const a = document.createElement('a');
    a.className = 'chat-file';
    a.href = att.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '📎 ' + att.fileName + ' (' + userChatFormatBytes(att.sizeBytes) + ')';
    box.appendChild(a);
  }
  const meta = document.createElement('div');
  meta.className = 'chat-meta';
  meta.textContent = fmtDate(msg.createdAt);
  box.appendChild(meta);
  return box;
}

function appendUserChatMessage(msg) {
  el('user-chat-messages').appendChild(userChatMessageEl(msg));
  el('user-chat-empty').hidden = true;
}

function scrollUserChatToBottom() {
  const box = el('user-chat-messages');
  box.scrollTop = box.scrollHeight;
}

function updateUserChatBadge(unread) {
  const badge = el('chat-user-unread-badge');
  badge.textContent = String(unread);
  badge.hidden = unread === 0;
}

async function markUserChatRead() {
  try {
    await authApi('/api/chat/read', { method: 'POST', body: '{}' });
    updateUserChatBadge(0);
  } catch { /* the next poll retries */ }
}

function isChatCardVisible() {
  const card = el('chat-card');
  if (card.hidden) return false;
  const r = card.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
}

async function loadUserChat() {
  if (userChatLoading) return;
  userChatLoading = true;
  try {
    const data = await authApi('/api/chat/thread' + (userChatLastId ? '?after=' + userChatLastId : ''));
    hideError(el('user-chat-error'));
    const messages = data.messages || [];
    for (const m of messages) {
      appendUserChatMessage(m);
      userChatLastId = Math.max(userChatLastId, m.id);
    }
    if (messages.length) scrollUserChatToBottom();
    const unread = data.thread ? data.thread.userUnread : 0;
    updateUserChatBadge(unread);
    if (unread > 0 && isChatCardVisible()) markUserChatRead();
  } catch (e) {
    // Polling retries in 5 seconds; only a first-load failure is shown.
    if (userChatLastId === 0) showError(el('user-chat-error'), e.message || 'ჩატის ჩატვირთვა ვერ მოხერხდა.');
  } finally {
    userChatLoading = false;
  }
}

function startUserChat() {
  stopUserChat();
  userChatLastId = 0;
  el('user-chat-messages').innerHTML = '';
  el('user-chat-empty').hidden = false;
  hideError(el('user-chat-error'));
  loadUserChat();
  userChatPollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadUserChat();
  }, USER_CHAT_POLL_MS);
  if ('IntersectionObserver' in window) {
    userChatObserver = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) loadUserChat();
    });
    userChatObserver.observe(el('chat-card'));
  }
}

function stopUserChat() {
  if (userChatPollTimer) clearInterval(userChatPollTimer);
  userChatPollTimer = null;
  if (userChatObserver) userChatObserver.disconnect();
  userChatObserver = null;
  userChatLastId = 0;
}

el('user-chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('user-chat-send-btn');
  const err = el('user-chat-error');
  hideError(err);
  const input = el('user-chat-input');
  const body = input.value.trim();
  if (!body) return;
  btn.disabled = true;
  try {
    const data = await authApi('/api/chat/send', {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    input.value = '';
    appendUserChatMessage(data.message);
    userChatLastId = Math.max(userChatLastId, data.message.id);
    scrollUserChatToBottom();
  } catch (e2) {
    showError(err, e2.message || 'გაგზავნა ვერ მოხერხდა.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- Profile pages (v8.0) ---------------- */
// Public page at /@username. Creation is EXPLICIT and requires a
// verified email (the server enforces the same gate). Buttons are
// MANUALLY curated: nothing auto-publishes — the user adds chosen
// short links or hand-typed https URLs. The view-counter toggle lives
// ONLY in the settings panel; the editor shows the count + a hint.
// All user content is rendered with the DOM API (textContent), never
// innerHTML, so no markup can break out.

function profilePageUrl() {
  if (!authUser) return '';
  return window.location.origin + '/@' + authUser.username;
}

function updateNavMenu() {
  const item = el('nav-menu-profile');
  item.textContent = myProfile ? '🌐 პროფილის რედაქტირება' : '🌐 პროფილის შექმნა';
  // Top-right button shows the avatar when the profile has one.
  const img = el('nav-avatar-img');
  const fallback = el('nav-avatar-fallback');
  if (myProfile && myProfile.hasAvatar && authUser) {
    img.src = '/@' + authUser.username + '/avatar?v=' + Date.now();
    img.hidden = false;
    fallback.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    fallback.hidden = false;
  }
}

async function loadMyProfile() {
  try {
    const data = await authApi('/api/profile/me');
    myProfile = data.profile || null;
    profileLoaded = true;
    renderProfileEditor();
    updateNavMenu();
    updateSettingsToggle();
  } catch (e) {
    // Logged-out users (401) never reach this; a real failure just
    // leaves the profile card hidden — the menu still says "შექმნა".
    profileLoaded = false;
  }
}

function renderProfileEditor() {
  if (!authUser) return;
  const card = el('profile-card');
  card.hidden = false;
  const createBox = el('profile-create-box');
  const editBox = el('profile-edit-box');
  hideError(el('profile-error'));
  if (!myProfile) {
    createBox.hidden = false;
    editBox.hidden = true;
    el('profile-create-url').textContent = profilePageUrl();
    const unverified = !authUser.emailVerified;
    el('profile-create-unverified').hidden = !unverified;
    el('profile-create-btn').disabled = unverified;
    return;
  }
  createBox.hidden = true;
  editBox.hidden = false;

  el('profile-views-line').textContent =
    `👁 ${myProfile.viewCount} ნახვა · მრიცხველი ${myProfile.showViews ? 'ჩანს' : 'გამორთულია'} (იცვლება პარამეტრებში)`;
  const viewLink = el('profile-view-link');
  viewLink.href = profilePageUrl();
  viewLink.textContent = profilePageUrl().replace(/^https?:\/\//, '');

  renderProfileAvatarPreview();
  el('profile-display-name').value = myProfile.displayName || '';
  el('profile-bio').value = myProfile.bio || '';
  el('profile-links-count').textContent = `${myProfile.links.length} / ${myProfile.linkLimit}`;
  renderProfileLinks();
}

function renderProfileAvatarPreview() {
  const img = el('profile-avatar-preview');
  const initials = el('profile-avatar-initials');
  const removeBtn = el('profile-avatar-remove-btn');
  if (myProfile && myProfile.hasAvatar && authUser) {
    img.src = '/@' + authUser.username + '/avatar?v=' + Date.now();
    img.hidden = false;
    initials.hidden = true;
    removeBtn.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    const first = ((myProfile && myProfile.displayName) || (authUser && authUser.username) || '?').trim().charAt(0).toUpperCase() || '?';
    initials.textContent = first;
    initials.hidden = false;
    removeBtn.hidden = true;
  }
}

// Compresses/resizes the avatar to max 512px (canvas, JPEG ~0.85, white
// background) — the same pattern as chat image compression in app.js.
// The server still enforces the 2 MB cap on decoded bytes.
function prepareProfileAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 512;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const out = canvas.toDataURL('image/jpeg', 0.85);
        const comma = out.indexOf(',');
        resolve({ mimeType: 'image/jpeg', dataBase64: out.slice(comma + 1) });
      };
      img.onerror = () => reject(new Error('ფოტოს წაკითხვა ვერ მოხერხდა.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('ფოტოს წაკითხვა ვერ მოხერხდა.'));
    reader.readAsDataURL(file);
  });
}

function renderProfileLinks() {
  const list = el('profile-links-list');
  list.innerHTML = '';
  const links = myProfile ? myProfile.links : [];
  el('profile-links-empty').hidden = links.length !== 0;
  links.forEach((link, i) => list.appendChild(profileLinkRow(link, i, links.length)));
}

function profileLinkRow(link, index, total) {
  const card = document.createElement('div');
  card.className = 'link-card';

  const top = document.createElement('div');
  top.className = 'link-top';
  const title = document.createElement('span');
  title.className = 'link-alias';
  title.textContent = link.title;
  top.appendChild(title);
  const badge = document.createElement('span');
  if (link.missing) {
    badge.className = 'badge expired';
    badge.textContent = 'წაშლილია';
  } else {
    badge.className = 'badge on';
    badge.textContent = link.kind === 'short' ? 'მოკლე ბმული' : 'ხელით';
  }
  top.appendChild(badge);
  card.appendChild(top);

  const dest = document.createElement('p');
  dest.className = 'link-dest';
  if (link.url) {
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.url;
    dest.appendChild(a);
  } else {
    dest.textContent = 'ბმული წაშლილია — წაშალეთ ეს ღილაკიც.';
  }
  card.appendChild(dest);

  const actions = document.createElement('div');
  actions.className = 'link-actions';

  const upBtn = document.createElement('button');
  upBtn.className = 'btn small';
  upBtn.textContent = '↑';
  upBtn.title = 'ზემოთ';
  upBtn.disabled = index === 0;
  upBtn.addEventListener('click', () => moveProfileLink(index, -1));
  actions.appendChild(upBtn);

  const downBtn = document.createElement('button');
  downBtn.className = 'btn small';
  downBtn.textContent = '↓';
  downBtn.title = 'ქვემოთ';
  downBtn.disabled = index === total - 1;
  downBtn.addEventListener('click', () => moveProfileLink(index, 1));
  actions.appendChild(downBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'btn small';
  editBtn.textContent = '✏️';
  editBtn.title = 'რედაქტირება';
  editBtn.addEventListener('click', () => openProfileLinkModal(link));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn small danger';
  delBtn.textContent = 'წაშლა';
  delBtn.addEventListener('click', async () => {
    if (!window.confirm('ნამდვილად წავშალო ღილაკი „' + link.title + '"?')) return;
    try {
      await authApi('/api/profile/links/' + link.id, { method: 'DELETE' });
      toast('ღილაკი წაიშალა');
      loadMyProfile();
    } catch (e) { showError(el('profile-error'), e.message || 'წაშლა ვერ მოხერხდა.'); }
  });
  actions.appendChild(delBtn);

  card.appendChild(actions);
  return card;
}

async function moveProfileLink(index, dir) {
  if (!myProfile) return;
  const links = myProfile.links.slice();
  const j = index + dir;
  if (j < 0 || j >= links.length) return;
  const tmp = links[index];
  links[index] = links[j];
  links[j] = tmp;
  try {
    await authApi('/api/profile/links/reorder', {
      method: 'POST',
      body: JSON.stringify({ ordered_ids: links.map((l) => l.id) }),
    });
    myProfile.links = links;
    renderProfileLinks();
  } catch (e) {
    showError(el('profile-error'), e.message || 'გადალაგება ვერ მოხერხდა.');
    loadMyProfile();
  }
}

function openProfileLimitModal() {
  el('profile-limit-modal-count').textContent = myProfile ? String(myProfile.linkLimit) : '5';
  el('profile-limit-modal').hidden = false;
}

function populateProfileShortSelect() {
  const select = el('profile-add-short-select');
  select.innerHTML = '';
  for (const link of authMyLinks) {
    const opt = document.createElement('option');
    opt.value = String(link.id);
    opt.textContent = link.shortUrl.replace(/^https?:\/\//, '') + (link.note ? ' · ' + link.note : '');
    select.appendChild(opt);
  }
  el('profile-add-short-empty').hidden = authMyLinks.length !== 0;
  select.hidden = authMyLinks.length === 0;
}

function setProfileAddMode(mode) {
  profileAddMode = mode;
  el('profile-add-tab-short').classList.toggle('active', mode === 'short');
  el('profile-add-tab-manual').classList.toggle('active', mode === 'manual');
  el('profile-add-short-box').hidden = mode !== 'short';
  el('profile-add-manual-box').hidden = mode !== 'manual';
}

function openProfileLinkModal(link) {
  profileLinkEditingId = link.id;
  el('profile-link-modal-title').value = link.title;
  el('profile-link-modal-url-field').hidden = link.kind !== 'manual';
  el('profile-link-modal-url').value = link.kind === 'manual' ? (link.url || '') : '';
  hideError(el('profile-link-modal-error'));
  el('profile-link-modal').hidden = false;
}

/* --- Settings panel (v8.0): all user settings + view-counter toggle --- */

function updateSettingsToggle() {
  const toggle = el('settings-show-views');
  if (myProfile) {
    toggle.checked = !!myProfile.showViews;
    toggle.disabled = false;
    el('settings-no-profile-hint').hidden = true;
  } else {
    toggle.checked = false;
    toggle.disabled = true;
    el('settings-no-profile-hint').hidden = false;
  }
}

function openSettings() {
  if (!authUser) return;
  el('settings-account').textContent = '@' + authUser.username + ' · ' + authUser.email;
  el('settings-verified').textContent = authUser.emailVerified ? 'მეილი დადასტურებულია ✓' : 'მეილი არ არის დადასტურებული';
  updateSettingsToggle();
  hideError(el('settings-error'));
  el('settings-modal').hidden = false;
}

function closeSettings() {
  el('settings-modal').hidden = true;
}

/* --- Profile event listeners --- */

el('profile-create-btn').addEventListener('click', async () => {
  const btn = el('profile-create-btn');
  btn.disabled = true;
  try {
    const data = await authApi('/api/profile', { method: 'POST', body: '{}' });
    myProfile = data.profile;
    profileLoaded = true;
    renderProfileEditor();
    updateNavMenu();
    updateSettingsToggle();
    toast('პროფილი შეიქმნა');
  } catch (e) {
    showError(el('profile-error'), e.message || 'პროფილის შექმნა ვერ მოხერხდა.');
  } finally {
    btn.disabled = authUser ? !authUser.emailVerified : true;
  }
});

el('profile-save-btn').addEventListener('click', async () => {
  const err = el('profile-error');
  hideError(err);
  try {
    const data = await authApi('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        display_name: el('profile-display-name').value,
        bio: el('profile-bio').value,
      }),
    });
    myProfile = data.profile;
    renderProfileEditor();
    updateNavMenu();
    toast('შენახულია');
  } catch (e) {
    showError(err, e.message || 'შენახვა ვერ მოხერხდა.');
  }
});

el('profile-copy-link-btn').addEventListener('click', async () => {
  if (await copyText(profilePageUrl())) toast('პროფილის ბმული დაკოპირდა');
  else toast('კოპირება ვერ მოხერხდა');
});

el('profile-settings-hint-btn').addEventListener('click', openSettings);

el('profile-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || profileAvatarBusy) return;
  const err = el('profile-error');
  hideError(err);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    showError(err, 'ფოტოს ტიპი დაუშვებელია — PNG, JPEG ან WebP შეიძლება.');
    return;
  }
  profileAvatarBusy = true;
  try {
    const avatar = await prepareProfileAvatar(file);
    await authApi('/api/profile/avatar', {
      method: 'POST',
      body: JSON.stringify({ avatar }),
    });
    toast('ფოტო აიტვირთა');
    loadMyProfile();
  } catch (e2) {
    showError(err, e2.message || 'ფოტოს ატვირთვა ვერ მოხერხდა.');
  } finally {
    profileAvatarBusy = false;
  }
});

el('profile-avatar-remove-btn').addEventListener('click', async () => {
  if (!window.confirm('პროფილის ფოტო მოვხსნა?')) return;
  try {
    await authApi('/api/profile/avatar', { method: 'DELETE' });
    toast('ფოტო მოიხსნა');
    loadMyProfile();
  } catch (e) {
    showError(el('profile-error'), e.message || 'ფოტოს მოხსნა ვერ მოხერხდა.');
  }
});

el('profile-add-link-btn').addEventListener('click', () => {
  if (!myProfile) return;
  if (myProfile.links.length >= myProfile.linkLimit) {
    openProfileLimitModal();
    return;
  }
  populateProfileShortSelect();
  setProfileAddMode('short');
  el('profile-add-title').value = '';
  el('profile-add-manual-url').value = '';
  hideError(el('profile-error'));
  el('profile-add-box').hidden = false;
});

el('profile-add-cancel-btn').addEventListener('click', () => {
  el('profile-add-box').hidden = true;
});

el('profile-add-tab-short').addEventListener('click', () => setProfileAddMode('short'));
el('profile-add-tab-manual').addEventListener('click', () => setProfileAddMode('manual'));

el('profile-add-save-btn').addEventListener('click', async () => {
  const err = el('profile-error');
  hideError(err);
  const title = el('profile-add-title').value.trim();
  if (!title) {
    showError(err, 'სათაური შეიყვანეთ.');
    return;
  }
  let body;
  if (profileAddMode === 'short') {
    const linkId = parseInt(el('profile-add-short-select').value, 10);
    if (!Number.isFinite(linkId)) {
      showError(err, 'ბმული აირჩიეთ.');
      return;
    }
    body = { kind: 'short', link_id: linkId, title };
  } else {
    let url = el('profile-add-manual-url').value.trim();
    if (!url) {
      showError(err, 'მისამართი შეიყვანეთ.');
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    body = { kind: 'manual', url, title };
  }
  try {
    await authApi('/api/profile/links', { method: 'POST', body: JSON.stringify(body) });
    el('profile-add-box').hidden = true;
    toast('ბმული დაემატა');
    loadMyProfile();
  } catch (e) {
    if (e.data && e.data.error === 'limit_reached') openProfileLimitModal();
    else showError(err, e.message || 'დამატება ვერ მოხერხდა.');
  }
});

el('profile-link-modal-save').addEventListener('click', async () => {
  if (!profileLinkEditingId) return;
  const err = el('profile-link-modal-error');
  hideError(err);
  const link = myProfile ? myProfile.links.find((l) => l.id === profileLinkEditingId) : null;
  const body = { title: el('profile-link-modal-title').value };
  if (link && link.kind === 'manual') {
    let url = el('profile-link-modal-url').value.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    body.url = url;
  }
  try {
    await authApi('/api/profile/links/' + profileLinkEditingId, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    el('profile-link-modal').hidden = true;
    profileLinkEditingId = null;
    toast('შენახულია');
    loadMyProfile();
  } catch (e) {
    showError(err, e.message || 'შენახვა ვერ მოხერხდა.');
  }
});
el('profile-link-modal-close').addEventListener('click', () => { el('profile-link-modal').hidden = true; });
el('profile-link-modal').addEventListener('click', (e) => {
  if (e.target === el('profile-link-modal')) el('profile-link-modal').hidden = true;
});

el('profile-limit-close').addEventListener('click', () => { el('profile-limit-modal').hidden = true; });
el('profile-limit-modal').addEventListener('click', (e) => {
  if (e.target === el('profile-limit-modal')) el('profile-limit-modal').hidden = true;
});
el('profile-limit-chat-btn').addEventListener('click', () => {
  el('profile-limit-modal').hidden = true;
  const card = el('chat-card');
  if (card.hidden) {
    toast('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებს აქვთ.');
    return;
  }
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el('user-chat-input').focus();
});

/* --- Settings panel listeners --- */

el('nav-settings-btn').addEventListener('click', openSettings);
el('settings-close').addEventListener('click', closeSettings);
el('settings-modal').addEventListener('click', (e) => {
  if (e.target === el('settings-modal')) closeSettings();
});
el('settings-show-views').addEventListener('change', async (e) => {
  const err = el('settings-error');
  hideError(err);
  const checked = e.target.checked;
  try {
    const data = await authApi('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({ show_views: checked }),
    });
    myProfile = data.profile;
    renderProfileEditor();
    toast(checked ? 'ნახვების მრიცხველი ჩართულია' : 'ნახვების მრიცხველი გამორთულია');
  } catch (e2) {
    e.target.checked = !checked;
    showError(err, e2.message || 'შენახვა ვერ მოხერხდა.');
  }
});

/* --- Left navigation menu --- */

el('nav-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = el('nav-menu');
  menu.hidden = !menu.hidden;
  el('nav-menu-btn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (e) => {
  const menu = el('nav-menu');
  if (!menu.hidden && !menu.contains(e.target) && e.target !== el('nav-menu-btn')) {
    menu.hidden = true;
    el('nav-menu-btn').setAttribute('aria-expanded', 'false');
  }
});
document.querySelectorAll('.nav-menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    el('nav-menu').hidden = true;
    el('nav-menu-btn').setAttribute('aria-expanded', 'false');
    const target = document.getElementById(item.dataset.navTarget);
    if (target && !target.hidden) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ---------------- Start ---------------- */

checkUserAuth();
