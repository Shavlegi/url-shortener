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
  el('auth-logged-in').hidden = false;
  el('user-name').textContent = user ? user.username : '';
  el('my-links-card').hidden = false;
  hideAuthCard();
  if (user) loadMyLinks();
  // v5: QR favorites switch to the server list when logged in.
  if (typeof loadQrFavorites === 'function') loadQrFavorites();
}

function setLoggedOut() {
  authUser = null;
  authMyLinks = [];
  el('auth-logged-out').hidden = false;
  el('auth-logged-in').hidden = true;
  el('my-links-card').hidden = true;
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

/* ---------------- Start ---------------- */

checkUserAuth();
