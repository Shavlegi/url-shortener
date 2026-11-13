/**
 * Mini Link — Cloudflare Worker (backend + hosting)
 * ======================================================
 * Stack: Cloudflare Workers + Cloudflare D1 + plain HTML/CSS/JS frontend.
 * No paid services. No visitor tracking: visitor IPs are NEVER stored —
 * rate limiting uses SHA-256 hashes of the IP (salt rotates daily).
 *
 * Deployment modes:
 *  1. Wrangler / Cloudflare dashboard "Connect to Git": static frontend files
 *     in public/ are served via the ASSETS binding (see wrangler.toml).
 *  2. Dashboard "Quick Edit" (paste a single file): run
 *     `npm run build:single` first — it inlines public/* into EMBEDDED_FILES
 *     below and writes dist/worker-single-file.js.
 *
 * Required environment (Cloudflare secrets — never commit real values):
 *  - ADMIN_PASSWORD_HASH : "pbkdf2$<iterations>$<saltB64>$<hashB64>"
 *                          (generate with scripts/make-hash.html)
 *  - SESSION_SECRET      : long random string (pepper for session token hashes)
 * Optional:
 *  - RATE_LIMIT_SALT     : extra salt for rate-limit IP hashes
 *  - RESEND_API_KEY      : Resend API key for user email verification +
 *                          password reset (v2). If unset, users are still
 *                          created as unverified, but no verification email
 *                          is sent and the API reports "email_not_configured".
 *                          Get one at resend.com (free tier: 3,000/mo,
 *                          100/day) and verify minilink.space there first.
 *                          The key lives ONLY as a Cloudflare secret.
 *  - TELEGRAM_BOT_TOKEN  : Telegram Bot API token from @BotFather (v7 bot).
 *                          If unset, the webhook reports
 *                          "telegram_not_configured" and does nothing.
 *  - TELEGRAM_WEBHOOK_SECRET : random string set as the webhook's
 *                          secret_token (v7). Requests without a matching
 *                          X-Telegram-Bot-Api-Secret-Token header are
 *                          rejected with 403. Both Telegram values live
 *                          ONLY as Cloudflare secrets — never in code.
 *
 * D1 binding: env.DB (see wrangler.toml + migrations/0001_init.sql)
 */

const EMBEDDED_FILES = {}; // replaced by scripts/build-single-file.js (single-file build)

const CONFIG = {
  aliasLength: 6,
  aliasAlphabet: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  customAliasMin: 3,
  customAliasMax: 32,
  maxUrlLength: 2048,
  sessionDays: 7,
  pbkdf2Iterations: 100000,
  // Public site vs admin panel, split by hostname (see isAdminHost):
  // the public shorten form lives on publicHost; the admin login +
  // dashboard on adminHost and on *.workers.dev.
  publicHost: 'minilink.space',
  adminHost: 'admin.minilink.space',
  // Rate limits (per hashed IP).
  loginMaxAttempts: 5, // per 10 minutes
  loginWindowSec: 600,
  publicCreateMaxPerMin: 3, // public shorten form, per IP
  publicCreateMaxPerHour: 10, // public shorten form, per IP
  apiMaxPerMin: 60,
  redirectMaxPerMin: 120,
  maxLinksList: 200,
  maxVisitorsList: 1000,
  visitorRetentionMs: 30 * 24 * 3600 * 1000, // v10.0: visitor IPs auto-delete after 30 days
  beaconMaxPerMin: 30, // v10.3: screen-size beacon, per IP
  beaconMaxPerHour: 300, // v10.3: screen-size beacon, per IP
  eventMaxPerMin: 60, // v10.4: behavior events, per IP
  eventMaxPerHour: 600, // v10.4: behavior events, per IP
  maxVisitEvents: 5000, // v10.4: visit_events cap (newest kept)
  visitorNoteMaxChars: 500, // v10.4: admin note per visitor IP
  maxImportLinks: 500,
  // v2: user accounts (voluntary — anonymous shortening stays as-is).
  usernameMin: 3,
  usernameMax: 20,
  passwordMin: 8,
  passwordMax: 128,
  emailCodeExpiryMs: 10 * 60 * 1000, // 6-digit code valid for 10 minutes
  emailCodeMaxAttempts: 5, // wrong code entries before it is invalidated
  registerMaxPerHourIp: 3, // registrations per hour, per IP hash
  registerMaxPerHourEmail: 5, // registrations per hour, per email hash
  userLoginMaxAttempts: 5, // per 10 minutes, per username+IP hash
  userLoginWindowSec: 600,
  resendCodeMaxPerMin: 1, // verification-code resends per minute, per email hash
  resendCodeMaxPerHour: 5, // verification-code resends per hour, per email hash
  forgotMaxPerHourEmail: 3, // password-reset requests per hour, per email hash
  forgotMaxPerHourIp: 10, // password-reset requests per hour, per IP hash
  // v7: Telegram bot (per hashed Telegram user id — the raw id is never stored).
  telegramMaxPerMin: 3, // bot link creations per minute, per user
  telegramMaxPerHour: 10, // bot link creations per hour, per user
  telegramQrMaxPerMin: 10, // bot /qr generations per minute, per user
  telegramQrMaxPerHour: 60, // bot /qr generations per hour, per user
  // v7.0: admin chat (1:1 with email-verified users). v7.3: attachments
  // live in the private R2 bucket (env.CHAT_FILES), not in D1.
  chatMaxBodyChars: 2000, // message text cap
  chatMaxAttachmentBytes: 5 * 1024 * 1024, // 5 MB decoded (v7.3, R2 storage)
  chatUserMaxPerMin: 10, // messages per minute, per user id
  chatUserMaxPerHour: 100, // messages per hour, per user id
  chatAdminMaxPerMin: 30, // admin messages per minute
  chatMaxMessages: 100, // messages returned per fetch
  // v8.0: public profile pages (/@username). Avatars live in the same
  // private R2 bucket as chat files (env.CHAT_FILES), under avatars/.
  profileMaxDisplayName: 50, // display name cap, chars
  profileMaxBio: 160, // bio cap, chars
  profileMaxTitle: 60, // profile link button title cap, chars
  profileDefaultLinkLimit: 5, // profile buttons per user, unless the admin raises it
  profileMaxLinkLimit: 100, // admin-set link limit cap
  profileAvatarMaxBytes: 2 * 1024 * 1024, // 2 MB decoded
  profileWriteMaxPerMin: 30, // profile mutations per minute, per user id
  mailFrom: 'Mini Link <noreply@minilink.space>',
};

// Short-code namespaces that must never be usable as aliases (they are routes).
const RESERVED_ALIASES = new Set([
  'api', 'admin', 'login', 'logout', 'static', 'assets', 'dashboard',
  'qr', 'export', 'import', 'health', 'robots.txt', 'favicon.ico',
  'sitemap.xml', 'index.html', 'admin.html', 'app.js', 'public.js',
  'auth.js', 'public', 'styles.css', 'qrcode.min.js',
]);

// Destination hosts that are themselves URL shorteners — linking to them would
// create redirect chains and is a classic abuse pattern. Blocked as destinations.
const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'rb.gy', 'cutt.ly', 'is.gd',
  'buff.ly', 'ow.ly', 'shorturl.at', 'tiny.cc', 'rebrand.ly', 'bl.ink',
  'shorte.st', 'adf.ly', 'bc.vc', 'soo.gd', 's.id', 'v.gd', 'qr.net',
]);

// Top-level domains with a long, documented history of abuse. This list is
// intentionally short and INCOMPLETE — it is one layer only, not a guarantee.
// .zip / .mov are blocked because they mimic file extensions; the others are
// former "free" TLDs heavily used for phishing and malware.
const BLOCKED_TLDS = new Set(['zip', 'mov', 'tk', 'ml', 'ga', 'cf', 'gq']);

// Big-brand names used for impersonation checks. A destination hostname that
// CONTAINS one of these names is blocked UNLESS it is the brand's real domain
// (brand.com or *.brand.com). This stops lookalikes such as
// "paypal-secure-login.com" while allowing the real "paypal.com".
const BRAND_NAMES = [
  'paypal', 'google', 'facebook', 'instagram', 'apple', 'microsoft',
  'amazon', 'netflix', 'binance', 'steam', 'whatsapp', 'telegram',
];

// User-Agent fragments that mark automated traffic. Bot visits are redirected
// but NOT counted, so click numbers reflect (mostly) real visitors.
const BOT_UA = [
  'bot', 'spider', 'crawler', 'facebookexternalhit', 'twitterbot',
  'telegrambot', 'whatsapp', 'slackbot', 'linkedinbot', 'discordbot',
  'googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'headless',
  'phantomjs', 'curl', 'wget', 'python-requests', 'go-http-client',
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function textEncoder() {
  return new TextEncoder();
}

function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string comparison (avoids leaking match position via timing).
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomTokenHex(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const m = header.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]+)'));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function sessionCookie(token, expiresAt, secure) {
  const parts = [
    `session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------------------------------------------ */
/* Password + sessions (PBKDF2-SHA256 via WebCrypto)                   */
/* ------------------------------------------------------------------ */

// Stored format: pbkdf2$<iterations>$<salt base64>$<hash base64>
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1000000) return false;
  let salt;
  try {
    salt = base64ToBytes(parts[2]);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', textEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return constantTimeEqual(bytesToBase64(new Uint8Array(bits)), parts[3]);
}

async function createSession(env) {
  const token = randomTokenHex(32);
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  const now = Date.now();
  const expiresAt = now + CONFIG.sessionDays * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
  ).bind(tokenHash, now, expiresAt).run();
  return { token, expiresAt };
}

async function getSession(env, request) {
  const token = getCookie(request, 'session');
  if (!token || token.length < 32) return null;
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  const row = await env.DB.prepare(
    'SELECT expires_at FROM sessions WHERE token_hash = ?',
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
    return null;
  }
  return row;
}

async function destroySession(env, request) {
  const token = getCookie(request, 'session');
  if (!token) return;
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
}

/* ------------------------------------------------------------------ */
/* v2: user accounts (voluntary) + email verification                  */
/*                                                                     */
/* Users are stored in the `users` table (migrations/0002_users.sql).  */
/* Their sessions live in a SEPARATE table (`user_sessions`) and a     */
/* SEPARATE cookie (`user_session`), so a user login never interferes  */
/* with the admin `session` cookie. Passwords use the same PBKDF2-     */
/* SHA256 helper shape as the admin password. Email codes are stored   */
/* ONLY as SHA-256 hashes (peppered with SESSION_SECRET) — never as    */
/* plaintext. Raw visitor IPs are never stored (same rule as v1).      */
/* ------------------------------------------------------------------ */

// Hash a user password into the same "pbkdf2$iter$salt$hash" format that
// verifyPassword() understands (so admin and user passwords share code).
async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', textEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: CONFIG.pbkdf2Iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${CONFIG.pbkdf2Iterations}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

function validateUsername(username) {
  if (typeof username !== 'string') return { ok: false, reason: 'მომხმარებლის სახელი ტექსტი უნდა იყოს.' };
  const u = username.trim();
  if (u.length < CONFIG.usernameMin || u.length > CONFIG.usernameMax) {
    return { ok: false, reason: `მომხმარებლის სახელი ${CONFIG.usernameMin}–${CONFIG.usernameMax} სიმბოლოს შორის უნდა იყოს.` };
  }
  if (!/^[A-Za-z0-9_]+$/.test(u)) {
    return { ok: false, reason: 'მომხმარებლის სახელში მხოლოდ ასოები, ციფრები და _ შეიძლება.' };
  }
  return { ok: true, username: u };
}

function validateEmail(email) {
  if (typeof email !== 'string') return { ok: false, reason: 'მეილი ტექსტი უნდა იყოს.' };
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
    return { ok: false, reason: 'მეილის მისამართი არასწორია.' };
  }
  return { ok: true, email: e };
}

function validateUserPassword(password) {
  if (typeof password !== 'string' || password.length < CONFIG.passwordMin) {
    return { ok: false, reason: `პაროლი მინიმუმ ${CONFIG.passwordMin} სიმბოლოსგან უნდა შედგებოდეს.` };
  }
  if (password.length > CONFIG.passwordMax) {
    return { ok: false, reason: 'პაროლი ძალიან გრძელია.' };
  }
  return { ok: true };
}

function userToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    emailVerified: row.email_verified === 1,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

function userSessionCookie(token, expiresAt, secure) {
  const parts = [
    `user_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function createUserSession(env, userId) {
  const token = randomTokenHex(32);
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  const now = Date.now();
  const expiresAt = now + CONFIG.sessionDays * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    'INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(tokenHash, userId, now, expiresAt).run();
  return { token, expiresAt };
}

async function getUserSession(env, request) {
  const token = getCookie(request, 'user_session');
  if (!token || token.length < 32) return null;
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  const row = await env.DB.prepare(
    'SELECT us.user_id, us.expires_at, u.username, u.email, u.email_verified, u.disabled ' +
    'FROM user_sessions us JOIN users u ON u.id = us.user_id WHERE us.token_hash = ?',
  ).bind(tokenHash).first();
  if (!row) return null;
  if (row.expires_at < Date.now() || row.disabled === 1) {
    await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
    return null;
  }
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    emailVerified: row.email_verified === 1,
    expiresAt: row.expires_at,
  };
}

async function destroyUserSession(env, request) {
  const token = getCookie(request, 'user_session');
  if (!token) return;
  const tokenHash = await sha256Hex((env.SESSION_SECRET || '') + ':' + token);
  await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run().catch(() => {});
}

/* ---------------- Email verification codes ---------------- */

function generateEmailCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000)); // 6 digits, never starts with 0
}

// The code is stored only as this hash (peppered) — never as plaintext.
async function hashEmailCode(env, code) {
  return sha256Hex((env.SESSION_SECRET || '') + ':' + String(code).trim());
}

// Issue a fresh code for (user, purpose), invalidating any previous unused
// one of the same purpose. Returns the PLAINTEXT code (to be emailed only;
// it is never written to the database or to a log).
async function issueEmailCode(env, userId, email, purpose) {
  await env.DB.prepare(
    'UPDATE email_codes SET used = 1 WHERE user_id = ? AND purpose = ? AND used = 0',
  ).bind(userId, purpose).run();
  const code = generateEmailCode();
  const codeHash = await hashEmailCode(env, code);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO email_codes (user_id, email, purpose, code_hash, expires_at, attempts, used, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
  ).bind(userId, email, purpose, codeHash, now + CONFIG.emailCodeExpiryMs, now).run();
  return code;
}

// Check a submitted code. Returns { ok: true } or { ok: false, reason }.
// A correct code is consumed (used = 1). After 5 wrong attempts the code
// is invalidated and the user must request a new one.
async function verifyEmailCode(env, userId, purpose, code) {
  const row = await env.DB.prepare(
    'SELECT id, code_hash, expires_at, attempts FROM email_codes ' +
    'WHERE user_id = ? AND purpose = ? AND used = 0 ORDER BY created_at DESC LIMIT 1',
  ).bind(userId, purpose).first();
  if (!row) return { ok: false, reason: 'კოდი არასწორია ან ვადა გავიდა.' };
  if (row.expires_at <= Date.now()) {
    await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').bind(row.id).run().catch(() => {});
    return { ok: false, reason: 'კოდი არასწორია ან ვადა გავიდა.' };
  }
  if (row.attempts >= CONFIG.emailCodeMaxAttempts) {
    await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').bind(row.id).run().catch(() => {});
    return { ok: false, reason: 'ძალიან ბევრი არასწორი მცდელობა — ახალი კოდი მოითხოვეთ.' };
  }
  const hash = await hashEmailCode(env, code);
  if (!constantTimeEqual(hash, row.code_hash)) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run().catch(() => {});
    return { ok: false, reason: 'კოდი არასწორია.' };
  }
  await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').bind(row.id).run();
  return { ok: true };
}

/* ---------------- Email sending (Resend) ---------------- */

// Sends a 6-digit code via Resend (REST API: POST https://api.resend.com/emails).
// Free tier (verified 2026-11-10 on resend.com/pricing): $0/mo, 3,000 emails/mo,
// 100/day, 3 domains. Sending from noreply@minilink.space requires the
// domain to be verified in Resend first (SPF/DKIM DNS records).
// Returns { ok: true } or { ok: false, error: 'email_not_configured' |
// 'email_send_failed' }. The code and the recipient address are NEVER logged.
async function sendEmailCode(env, to, code, purpose) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'email_not_configured' };
  const isReset = purpose === 'reset';
  const title = isReset ? 'პაროლის აღდგენა' : 'მეილის დადასტურება';
  const subject = `Mini Link — ${isReset ? 'პაროლის აღდგენის კოდი' : 'მეილის დადასტურების კოდი'}`;
  const text =
    `Mini Link — ${title}\n\n` +
    `თქვენი კოდი: ${code}\n\n` +
    'კოდი 10 წუთით ვარგისია. თუ ეს თქვენ არ იყავით, უგულებელყავით ეს წერილი.';
  const html =
    '<!DOCTYPE html><html lang="ka"><body style="font-family:system-ui,sans-serif;color:#16213a">' +
    `<h2 style="margin:0 0 12px">Mini Link — ${title}</h2>` +
    '<p>თქვენი კოდი:</p>' +
    `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>` +
    '<p>კოდი 10 წუთით ვარგისია. თუ ეს თქვენ არ იყავით, უგულებელყავით ეს წერილი.</p>' +
    '</body></html>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: CONFIG.mailFrom, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j && (j.message || (j.error && j.error.message) || j.name)) || '';
      } catch { /* ignore */ }
      console.error('Resend send failed:', res.status, detail ? String(detail).slice(0, 200) : '');
      return { ok: false, error: 'email_send_failed' };
    }
    return { ok: true };
  } catch (e) {
    console.error('Resend send error:', e && e.message ? e.message : e);
    return { ok: false, error: 'email_send_failed' };
  }
}

/* ---------------- Lazy v2 schema migration ---------------- */

// Applies migrations/0002_users.sql idempotently on first use, so the live
// database (created before v2) gets the new tables without a manual step.
// A module-level flag skips the check on warm isolates; a schema_meta
// version flag makes a failed run retry safely on the next request.
let v2SchemaChecked = false;

async function ensureV2Schema(env) {
  if (v2SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v2_users'",
    ).first();
    if (flag && flag.value === '2') {
      v2SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS users (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'username TEXT NOT NULL UNIQUE, ' +
        'email TEXT NOT NULL UNIQUE, ' +
        'password_hash TEXT NOT NULL, ' +
        'email_verified INTEGER NOT NULL DEFAULT 0, ' +
        'disabled INTEGER NOT NULL DEFAULT 0, ' +
        'created_at INTEGER NOT NULL)',
      ),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_users_username ON users (username)'),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS user_sessions (' +
        'token_hash TEXT PRIMARY KEY, ' +
        'user_id INTEGER NOT NULL, ' +
        'created_at INTEGER NOT NULL, ' +
        'expires_at INTEGER NOT NULL)',
      ),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at)'),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS email_codes (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'user_id INTEGER NOT NULL, ' +
        'email TEXT NOT NULL, ' +
        'purpose TEXT NOT NULL, ' +
        'code_hash TEXT NOT NULL, ' +
        'expires_at INTEGER NOT NULL, ' +
        'attempts INTEGER NOT NULL DEFAULT 0, ' +
        'used INTEGER NOT NULL DEFAULT 0, ' +
        'created_at INTEGER NOT NULL)',
      ),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes (user_id, purpose, used, expires_at)'),
    ]);
    // links.user_id: new column for existing tables. If it already exists
    // (migration applied twice), SQLite errors with "duplicate column" —
    // that is the expected idempotent case, so swallow it only.
    try {
      await env.DB.prepare('ALTER TABLE links ADD COLUMN user_id INTEGER').run();
    } catch (e) {
      if (!String(e && e.message ? e.message : e).includes('duplicate column')) throw e;
    }
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_links_user ON links (user_id)').run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v2_users', '2')",
    ).run();
    v2SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v2 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v3 schema migration ---------------- */

// Same idempotent pattern as v2 (see ensureV2Schema): applies
// migrations/0003_click_events.sql on first use. The click_events table
// stores ONLY (link_id, clicked_at) — no IP, no User-Agent, no referrer,
// no country. Each link keeps at most its newest 100 events (pruned on
// every counted click in handleRedirect).
let v3SchemaChecked = false;

async function ensureV3Schema(env) {
  if (v3SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v3_click_events'",
    ).first();
    if (flag && flag.value === '3') {
      v3SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      ),
      env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS click_events (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'link_id INTEGER NOT NULL, ' +
        'clicked_at INTEGER NOT NULL)',
      ),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_click_events_link ON click_events (link_id, clicked_at DESC)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_click_events_time ON click_events (clicked_at)'),
    ]);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v3_click_events', '3')",
    ).run();
    v3SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v3 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v4 schema migration ---------------- */

// Same idempotent pattern as v2 (see ensureV2Schema): applies
// migrations/0004_link_notes.sql on first use. Adds an optional `note`
// column (label) to links. Old links keep NULL — treated as "no note".
let v4SchemaChecked = false;

async function ensureV4Schema(env) {
  if (v4SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v4_link_notes'",
    ).first();
    if (flag && flag.value === '4') {
      v4SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    // If the column already exists (migration applied twice), SQLite
    // errors with "duplicate column" — the expected idempotent case.
    try {
      await env.DB.prepare('ALTER TABLE links ADD COLUMN note TEXT').run();
    } catch (e) {
      if (!String(e && e.message ? e.message : e).includes('duplicate column')) throw e;
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v4_link_notes', '4')",
    ).run();
    v4SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v4 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v5 schema migration ---------------- */

// Same idempotent pattern as v4 (see ensureV4Schema): applies
// migrations/0005_qr_favorites.sql on first use. Adds a `qr_favorites`
// table for logged-in users' saved QR codes (label + payload + colors).
// Anonymous users keep favorites in localStorage on their own device.
let v5SchemaChecked = false;

async function ensureV5Schema(env) {
  if (v5SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v5_qr_favorites'",
    ).first();
    if (flag && flag.value === '5') {
      v5SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS qr_favorites (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'user_id INTEGER NOT NULL, ' +
      'type TEXT NOT NULL, ' +
      'label TEXT NOT NULL, ' +
      'payload TEXT NOT NULL, ' +
      "fg TEXT NOT NULL DEFAULT '#000000', " +
      "bg TEXT NOT NULL DEFAULT '#ffffff', " +
      'created_at INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_qr_favorites_user ON qr_favorites (user_id, created_at DESC)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v5_qr_favorites', '5')",
    ).run();
    v5SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v5 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v6 schema migration ---------------- */

// Same idempotent pattern as v5 (see ensureV5Schema): applies
// migrations/0006_qr_history.sql on first use. Adds a `qr_history` table
// that logs EVERY QR the Maker generates (logged-in users get their
// user_id attached, anonymous rows stay ownerless), so the admin sees
// everything — like links — not just saved favorites. `favorite` marks
// rows the user also saved as a favorite. Existing favorites (if any)
// are copied in as favorite=1.
let v6SchemaChecked = false;

async function ensureV6Schema(env) {
  if (v6SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v6_qr_history'",
    ).first();
    if (flag && flag.value === '6') {
      v6SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS qr_history (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'user_id INTEGER, ' +
      'type TEXT NOT NULL, ' +
      'label TEXT NOT NULL, ' +
      'payload TEXT NOT NULL, ' +
      "fg TEXT NOT NULL DEFAULT '#000000', " +
      "bg TEXT NOT NULL DEFAULT '#ffffff', " +
      'favorite INTEGER NOT NULL DEFAULT 0, ' +
      'created_at INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_qr_history_user ON qr_history (user_id, created_at DESC)',
    ).run();
    // Copy existing favorites in as favorite=1 (guarded: a retried
    // migration must not duplicate them).
    await env.DB.prepare(
      'INSERT INTO qr_history (user_id, type, label, payload, fg, bg, favorite, created_at) ' +
      'SELECT user_id, type, label, payload, fg, bg, 1, created_at FROM qr_favorites ' +
      'WHERE NOT EXISTS (SELECT 1 FROM qr_history h WHERE h.user_id = qr_favorites.user_id AND h.payload = qr_favorites.payload AND h.favorite = 1)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v6_qr_history', '6')",
    ).run();
    v6SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v6 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v7.0 schema migration ---------------- */

// Same idempotent pattern as v6 (see ensureV6Schema): applies
// migrations/0007_chat.sql on first use. Adds the admin-chat tables:
// one thread per user (chat_threads, user_id UNIQUE), text messages
// (chat_messages — NO blob column, so listing messages never touches
// file bytes) and file attachments in a SEPARATE table
// (chat_attachments, data BLOB, fetched only by id for downloads).
// Attachments are capped at 1.5 MB decoded — D1 caps a single value /
// row at 2,000,000 bytes. No new service, no new secret: D1 only.
let v7SchemaChecked = false;

async function ensureV7Schema(env) {
  if (v7SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v7_chat'",
    ).first();
    if (flag && flag.value === '7') {
      v7SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS chat_threads (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'user_id INTEGER NOT NULL UNIQUE, ' +
      'created_at INTEGER NOT NULL, ' +
      'last_message_at INTEGER NOT NULL, ' +
      'admin_unread INTEGER NOT NULL DEFAULT 0, ' +
      'user_unread INTEGER NOT NULL DEFAULT 0)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS chat_messages (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'thread_id INTEGER NOT NULL, ' +
      'sender TEXT NOT NULL, ' +
      'body TEXT NOT NULL, ' +
      'created_at INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, id)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS chat_attachments (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'message_id INTEGER NOT NULL, ' +
      'file_name TEXT NOT NULL, ' +
      'mime_type TEXT NOT NULL, ' +
      'size_bytes INTEGER NOT NULL, ' +
      'data BLOB NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments (message_id)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v7_chat', '7')",
    ).run();
    v7SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v7 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v8 schema migration ---------------- */

// Same idempotent pattern as v4 (see ensureV4Schema): applies
// migrations/0008_chat_r2.sql on first use. Adds an `r2_key` column
// (nullable) to chat_attachments: since v7.3, attachment bytes live
// in the private R2 bucket and D1 keeps only the object key. Old rows
// keep r2_key NULL and their legacy `data` blob — the download
// endpoint still serves those via the old path. The `data` column is
// kept (NOT NULL in the v7 schema) — new rows store an empty blob
// there, never read when r2_key is set.
let v8SchemaChecked = false;

async function ensureV8Schema(env) {
  if (v8SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v8_chat_r2'",
    ).first();
    if (flag && flag.value === '8') {
      v8SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    // If the column already exists (migration applied twice), SQLite
    // errors with "duplicate column" — the expected idempotent case.
    try {
      await env.DB.prepare('ALTER TABLE chat_attachments ADD COLUMN r2_key TEXT').run();
    } catch (e) {
      if (!String(e && e.message ? e.message : e).includes('duplicate column')) throw e;
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v8_chat_r2', '8')",
    ).run();
    v8SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v8 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ---------------- Lazy v9 schema migration ---------------- */

// Same idempotent pattern as v7 (see ensureV7Schema): applies
// migrations/0009_profiles.sql on first use. Adds the profile-pages
// tables: `profiles` (one row per user, created explicitly by the
// user) and `profile_links` (the user's manually curated buttons).
// Timestamps are ISO strings (TEXT) — profile dates are never
// displayed, only stored; older tables use epoch-ms INTEGERs.
let v9SchemaChecked = false;

async function ensureV9Schema(env) {
  if (v9SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v9_profiles'",
    ).first();
    if (flag && flag.value === '9') {
      v9SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS profiles (' +
      'user_id INTEGER PRIMARY KEY REFERENCES users(id), ' +
      "display_name TEXT NOT NULL DEFAULT '', " +
      "bio TEXT NOT NULL DEFAULT '', " +
      'avatar_r2_key TEXT, ' +
      'avatar_mime TEXT, ' +
      'show_views INTEGER NOT NULL DEFAULT 1, ' +
      'link_limit INTEGER NOT NULL DEFAULT 5, ' +
      'view_count INTEGER NOT NULL DEFAULT 0, ' +
      'created_at TEXT, ' +
      'updated_at TEXT)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS profile_links (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'user_id INTEGER NOT NULL REFERENCES users(id), ' +
      'position INTEGER NOT NULL DEFAULT 0, ' +
      'kind TEXT NOT NULL, ' +
      'link_id INTEGER REFERENCES links(id), ' +
      "title TEXT NOT NULL DEFAULT '', " +
      "url TEXT NOT NULL DEFAULT '', " +
      'created_at TEXT)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_profile_links_user ON profile_links (user_id, position)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v9_profiles', '9')",
    ).run();
    v9SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v9 schema migration failed:', e && e.message ? e.message : e);
  }
}

let v10SchemaChecked = false;

async function ensureV10Schema(env) {
  if (v10SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v10_visitors'",
    ).first();
    if (flag && flag.value === '10') {
      v10SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS visitors (' +
      'ip TEXT PRIMARY KEY, ' +
      'visits INTEGER NOT NULL DEFAULT 0, ' +
      'first_seen INTEGER NOT NULL, ' +
      'last_seen INTEGER NOT NULL, ' +
      "last_path TEXT NOT NULL DEFAULT '')",
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_visitors_last ON visitors (last_seen DESC)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_visitors_visits ON visitors (visits DESC)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v10_visitors', '10')",
    ).run();
    v10SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v10 schema migration failed:', e && e.message ? e.message : e);
  }
}

let v11SchemaChecked = false;

async function ensureV11Schema(env) {
  if (v11SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v11_ip_exclusions'",
    ).first();
    if (flag && flag.value === '11') {
      v11SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ip_exclusions (' +
      'ip TEXT PRIMARY KEY, ' +
      'created_at INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v11_ip_exclusions', '11')",
    ).run();
    v11SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v11 schema migration failed:', e && e.message ? e.message : e);
  }
}

let v12SchemaChecked = false;

async function ensureV12Schema(env) {
  if (v12SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v12_visitor_users'",
    ).first();
    if (flag && flag.value === '12') {
      v12SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS visitor_users (' +
      'ip TEXT NOT NULL, ' +
      'user_id INTEGER NOT NULL REFERENCES users(id), ' +
      'last_seen INTEGER NOT NULL, ' +
      'PRIMARY KEY (ip, user_id))',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_visitor_users_user ON visitor_users (user_id, last_seen DESC)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v12_visitor_users', '12')",
    ).run();
    v12SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v12 schema migration failed:', e && e.message ? e.message : e);
  }
}

// ALTER TABLE ... ADD COLUMN for the v10.3 enrichment: on a database
// where migrations already ran, the column exists — "duplicate column"
// is expected and ignored; any other error aborts the migration.
async function addColumnIfMissing(env, sql) {
  try {
    await env.DB.prepare(sql).run();
  } catch (e) {
    if (!/duplicate column/i.test(e && e.message ? e.message : '')) throw e;
  }
}

let v13SchemaChecked = false;

async function ensureV13Schema(env) {
  if (v13SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v13_visit_enrichment'",
    ).first();
    if (flag && flag.value === '13') {
      v13SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    const cols = [
      'country TEXT', 'city TEXT', 'region TEXT', 'postal_code TEXT',
      'latitude REAL', 'longitude REAL', 'timezone TEXT', 'isp TEXT',
      'asn INTEGER', 'is_eu INTEGER', 'browser TEXT', 'os TEXT',
      'device TEXT', 'language TEXT', 'referrer TEXT',
    ];
    for (const col of cols) {
      await addColumnIfMissing(env, 'ALTER TABLE visitors ADD COLUMN ' + col);
    }
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS visit_hours (' +
      'day TEXT NOT NULL, ' +
      'hour INTEGER NOT NULL, ' +
      'visits INTEGER NOT NULL DEFAULT 0, ' +
      'PRIMARY KEY (day, hour))',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS path_stats (' +
      'path TEXT PRIMARY KEY, ' +
      'visits INTEGER NOT NULL DEFAULT 0, ' +
      'last_seen INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS screen_stats (' +
      'resolution TEXT PRIMARY KEY, ' +
      'visits INTEGER NOT NULL DEFAULT 0)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v13_visit_enrichment', '13')",
    ).run();
    v13SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v13 schema migration failed:', e && e.message ? e.message : e);
  }
}

let v14SchemaChecked = false;

async function ensureV14Schema(env) {
  if (v14SchemaChecked) return;
  try {
    const flag = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'v14_tracking_notes'",
    ).first();
    if (flag && flag.value === '14') {
      v14SchemaChecked = true;
      return;
    }
  } catch (e) {
    // schema_meta (or the flag) does not exist yet — migrate below.
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ).run();
    await addColumnIfMissing(env, 'ALTER TABLE visitors ADD COLUMN note TEXT');
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS visit_events (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'ip TEXT NOT NULL, ' +
      'session TEXT NOT NULL, ' +
      'type TEXT NOT NULL, ' +
      'path TEXT, ' +
      'label TEXT, ' +
      'seconds INTEGER, ' +
      'scroll INTEGER, ' +
      'created_at INTEGER NOT NULL)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_visit_events_ip ON visit_events(ip, created_at DESC)',
    ).run();
    await env.DB.prepare(
      'CREATE INDEX IF NOT EXISTS idx_visit_events_created ON visit_events(created_at)',
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('v14_tracking_notes', '14')",
    ).run();
    v14SchemaChecked = true;
  } catch (e) {
    // Flag stays unset — the next request retries the migration.
    console.error('v14 schema migration failed:', e && e.message ? e.message : e);
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting (D1-backed, keyed by hashed IP — the limiter itself   */
/* never stores raw IPs; visitor IPs live only in the v10 visitors    */
/* table, served admin-only)                                          */
/* ------------------------------------------------------------------ */

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10); // salt rotates daily
  return sha256Hex(ip + '|' + day + '|' + (env.RATE_LIMIT_SALT || 'url-shortener-default-salt'));
}

async function rateLimit(env, key, limit, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSec) * windowSec;
  const dbKey = `${key}:${windowStart}`;
  try {
    // Drop counters older than a day so the table does not grow forever.
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 86400).run();
    await env.DB.prepare(
      'INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET count = count + 1',
    ).bind(dbKey, windowStart).run();
    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(dbKey).first();
    return (row ? row.count : 1) <= limit;
  } catch (e) {
    // If rate limiting itself breaks, fail OPEN for availability but log it.
    // (Abuse protection degrades; the app stays usable.)
    console.error('rateLimit error:', e && e.message ? e.message : e);
    return true;
  }
}

async function checkRateLimit(request, env, scope, limit, windowSec) {
  const hash = await ipHash(request, env);
  return rateLimit(env, `${scope}:${hash}`, limit, windowSec);
}

/* ------------------------------------------------------------------ */
/* URL validation                                                      */
/* ------------------------------------------------------------------ */

function isIPv4(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isIPv6(host) {
  return host.includes(':');
}

function isPrivateIPv4(host) {
  const p = host.split('.').map((n) => parseInt(n, 10));
  if (p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true; // malformed -> treat as unsafe
  const [a, b] = p;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function baseDomain(host) {
  // Returns the registrable-ish tail (last two labels) for blocklist matching.
  const parts = host.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host;
}

/**
 * Validate a destination URL. Returns { ok: true, url } or { ok: false, reason }.
 * Rules (v1, strict on purpose — see SECURITY.md):
 *  - must parse, must be https:, max 2048 chars, no credentials, no fragment-only tricks
 *  - no IP-literal hosts at all (v4/v6, incl. private/loopback/link-local)
 *  - no localhost / .local / .internal / .lan / single-label hosts
 *  - no non-standard ports (only 443, the https default)
 *  - must not point at this shortener's own hosts (public + admin — self-redirect loop)
 *  - must not be another URL shortener (redirect-chain abuse)
 *  - blocked TLDs, brand-impersonation lookalikes (see lists above)
 */
function validateDestination(raw, ownHosts) {
  if (typeof raw !== 'string') return { ok: false, reason: 'ბმული ტექსტი უნდა იყოს.' };
  const input = raw.trim();
  if (!input) return { ok: false, reason: 'ბმული ცარიელია.' };
  if (input.length > CONFIG.maxUrlLength) return { ok: false, reason: 'ბმული ძალიან გრძელია (მაქს. 2048 სიმბოლო).' };
  if (/\s/.test(input)) return { ok: false, reason: 'ბმულში არ უნდა იყოს გამოტოვება (space).' };

  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'ბმული არასწორია — შეიყვანეთ სრული მისამართი, მაგ. https://example.com' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'მხოლოდ https:// ბმულები მიიღება.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'ბმულში მომხმარებლის სახელი/პაროლი დაუშვებელია.' };
  }

  const host = url.hostname.toLowerCase();
  if (!host || !host.includes('.')) {
    return { ok: false, reason: 'ბმულს სწორი დომენი უნდა ჰქონდეს.' };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
    return { ok: false, reason: 'ლოკალური/შიდა მისამართები დაუშვებელია.' };
  }
  if (isIPv4(host)) {
    return { ok: false, reason: 'IP მისამართზე ბმული დაუშვებელია — გამოიყენეთ დომენი.' };
  }
  if (isIPv6(host)) {
    return { ok: false, reason: 'IPv6 მისამართზე ბმული დაუშვებელია — გამოიყენეთ დომენი.' };
  }
  if (url.port && url.port !== '443') {
    return { ok: false, reason: 'არასტანდარტული პორტი დაუშვებელია.' };
  }
  if (ownHosts && ownHosts.some((h) => host === h || host.endsWith('.' + h))) {
    return { ok: false, reason: 'ბმული ამავე საიტზე მიუთითებს — ასეთი ბმულის შემოკლება დაუშვებელია.' };
  }
  if (SHORTENER_HOSTS.has(host) || SHORTENER_HOSTS.has(baseDomain(host))) {
    return { ok: false, reason: 'სხვა shortener-ის ბმულის შემოკლება დაუშვებელია.' };
  }
  const tld = host.split('.').pop();
  if (BLOCKED_TLDS.has(tld)) {
    return { ok: false, reason: 'ამ დომენური ზონის (. ' + tld + ') ბმულები უსაფრთხოების მიზნით იბლოკება.' };
  }
  // Brand impersonation: hostname contains a big-brand name but is not the
  // brand's real domain, and looks deceptive (hyphen / digit / punycode).
  const lowerHost = host.toLowerCase();
  for (const brand of BRAND_NAMES) {
    if (lowerHost.includes(brand)) {
      const isReal = lowerHost === brand + '.com' || lowerHost.endsWith('.' + brand + '.com');
      if (!isReal && (lowerHost.includes('xn--') || /[-0-9]/.test(lowerHost.replace(brand, '')))) {
        return { ok: false, reason: 'ბმული საეჭვოდ ჰგავს ცნობილი ბრენდის მისამართს და იბლოკება.' };
      }
    }
  }
  return { ok: true, url: url.toString() };
}

/* ------------------------------------------------------------------ */
/* Aliases                                                             */
/* ------------------------------------------------------------------ */

function generateAlias() {
  const buf = new Uint8Array(CONFIG.aliasLength);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += CONFIG.aliasAlphabet[b % CONFIG.aliasAlphabet.length];
  return out;
}

function validateCustomAlias(alias) {
  if (typeof alias !== 'string') return { ok: false, reason: 'სახელი ტექსტი უნდა იყოს.' };
  const a = alias.trim();
  if (a.length < CONFIG.customAliasMin || a.length > CONFIG.customAliasMax) {
    return { ok: false, reason: `სახელი ${CONFIG.customAliasMin}–${CONFIG.customAliasMax} სიმბოლოს შორის უნდა იყოს.` };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(a)) {
    return { ok: false, reason: 'სახელში მხოლოდ ასოები, ციფრები, - და _ შეიძლება.' };
  }
  if (RESERVED_ALIASES.has(a.toLowerCase())) {
    return { ok: false, reason: 'ეს სახელი დაცულია და მისი გამოყენება არ შეიძლება.' };
  }
  return { ok: true, alias: a };
}

// Insert a link with an auto-generated alias. Returns the alias, or null
// when all attempts fail (an extremely unlikely collision streak).
// userId: the owner (a logged-in user's id) or null for anonymous links.
/* ---------------- Link notes (v4) ---------------- */
// Optional label per link ("CV", "მაღაზია"), shown as the card title in
// the lists. Max 100 chars; empty string clears it (stored as NULL).
function validateNote(raw) {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'შენიშვნა ტექსტი უნდა იყოს.' };
  const note = raw.trim();
  if (note.length > 100) return { ok: false, reason: 'შენიშვნა მაქს. 100 სიმბოლო შეიძლება იყოს.' };
  return { ok: true, note: note === '' ? null : note };
}

async function insertAutoLink(env, destination, expiresMs, userId = null, note = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateAlias();
    try {
      const ins = await env.DB.prepare(
        'INSERT INTO links (alias, destination, created_at, expires_at, enabled, clicks, user_id, note) ' +
        'VALUES (?, ?, ?, ?, 1, 0, ?, ?)',
      ).bind(candidate, destination, Date.now(), expiresMs, userId, note).run();
      if (ins.success) return candidate;
    } catch (e) {
      if (!String(e && e.message ? e.message : e).includes('UNIQUE')) throw e;
    }
  }
  return null;
}

// True when the request arrived on an admin host: admin.minilink.space or
// the Worker's own *.workers.dev address. Everything else is the public site.
function isAdminHost(request) {
  const host = new URL(request.url).host.toLowerCase();
  return host === CONFIG.adminHost || host.endsWith('.workers.dev');
}

// All hostnames that belong to this shortener (public site + admin panel).
// A destination pointing at any of them is a self-redirect loop.
function ownHosts(request) {
  const host = new URL(request.url).host;
  const hosts = [host];
  for (const h of [CONFIG.publicHost, CONFIG.adminHost]) {
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  return hosts;
}

function publicLink(request, alias) {
  const u = new URL(request.url);
  // Short URLs always point at the public host, even when the link was
  // created from the admin panel (admin.minilink.space / *.workers.dev).
  const host = isAdminHost(request) && CONFIG.publicHost ? CONFIG.publicHost : u.host;
  return `${u.protocol}//${host}/${alias}`;
}

function linkRowToJson(request, row) {
  return {
    id: row.id,
    alias: row.alias,
    shortUrl: publicLink(request, row.alias),
    destination: row.destination,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    enabled: row.enabled === 1,
    clicks: row.clicks,
    // Optional label ("CV", "მაღაზია") — '' when the link has none.
    note: row.note !== undefined && row.note !== null ? row.note : '',
    // Owner username when the query joined users (admin list), otherwise
    // null — anonymous links and queries without the join.
    owner: row.owner !== undefined && row.owner !== null ? row.owner : null,
  };
}

/* ------------------------------------------------------------------ */
/* Vendored QR generator — qrcode-generator 1.4.4 (MIT), minified.    */
/* Same library file the website loads as public/qrcode.min.js;      */
/* copied here so the Worker can render QR matrices without a DOM,   */
/* a canvas, or an external QR service. Do not edit by hand —        */
/* replace the whole block from a fresh qrcode.min.js instead.       */
/* Source: https://github.com/kazuhikoarase/qrcode-generator         */
/* ------------------------------------------------------------------ */
var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,(function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1}))},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(n*r,o*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}((function(){return qrcode}));

// Byte-mode QR data is UTF-8 so /qr text in Georgian (or any script)
// decodes correctly. Short URLs are ASCII, so this changes nothing
// for link QR codes.
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];


/* ------------------------------------------------------------------ */
/* Telegram bot (v7) — webhook inside this same Worker                 */
/*                                                                     */
/* The bot lives at POST /api/telegram/webhook (see handleApi). It     */
/* shares this Worker's D1 database, URL validation, alias generator   */
/* and QR-history log with the website — bot links are normal Mini     */
/* Link links (note "Telegram") and appear in the admin panel.         */
/*                                                                     */
/* Setup (in the Cloudflare dashboard + Telegram, by the owner):       */
/*  1. @BotFather -> /newbot -> name + username -> bot token.          */
/*  2. Cloudflare secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET */
/*     (a long random string the owner invents; never in chat/code).   */
/*  3. Set the webhook once (browser address bar):                     */
/*     https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://minilink.space/api/telegram/webhook&secret_token=<SECRET> */
/*                                                                     */
/* Privacy (same rules as the website): the Telegram user id is NEVER  */
/* stored — rate limits use only its daily SHA-256 hash (peppered      */
/* with SESSION_SECRET). The bot never sees visitor IPs (Telegram's    */
/* servers call the webhook). QR generations are logged to qr_history  */
/* as anonymous rows, like anonymous website generations.              */
/*                                                                     */
/* QR images are rendered inside the Worker: the vendored              */
/* qrcode-generator matrix (same library as the website) is encoded    */
/* as a 1-bit grayscale PNG with stored DEFLATE blocks — no canvas,    */
/* no external QR service, no dependency.                              */
/* ------------------------------------------------------------------ */

const TG_START_TEXT =
  '👋 გამარჯობა! მე Mini Link-ის ბოტი ვარ.\n\n' +
  'ბმული გამომიგზავნე და მოკლე ბმულს + QR კოდს დაგიბრუნებ.\n\n' +
  'მაგალითად:\nhttps://example.com\n\n' +
  'ბრძანებები:\n' +
  '/qr <ტექსტი> — QR კოდი ნებისმიერი ტექსტისთვის\n' +
  '/help — დახმარება\n\n' +
  'მხოლოდ https:// ბმულები მიიღება. ლიმიტი: საათში 10 ბმული.';

const TG_HELP_TEXT =
  'Mini Link-ის ბოტი — ბმულების შემოკლება Telegram-ში.\n\n' +
  '• ბმული გამომიგზავნე (https://…) → მოკლე ბმულს + QR კოდს დაგიბრუნებ.\n' +
  '• /qr <ტექსტი> → QR კოდი ტექსტისთვის, ბმულის გარეშე.\n' +
  '• /start → დაწყება.\n\n' +
  'საიტი: https://minilink.space\n' +
  'ლიმიტი: 3 ბმული წუთში, 10 საათში.';

function telegramApiUrl(env, method) {
  return 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method;
}

async function tgSendMessage(env, chatId, text) {
  try {
    const res = await fetch(telegramApiUrl(env, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('Telegram sendMessage failed:', res.status);
    return res.ok;
  } catch (e) {
    console.error('Telegram sendMessage error:', e && e.message ? e.message : e);
    return false;
  }
}

async function tgSendPhoto(env, chatId, pngBytes, caption) {
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([pngBytes], { type: 'image/png' }), 'qr.png');
    if (caption) form.append('caption', caption);
    const res = await fetch(telegramApiUrl(env, 'sendPhoto'), { method: 'POST', body: form });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j && j.description) || '';
      } catch { /* ignore */ }
      console.error('Telegram sendPhoto failed:', res.status, detail);
    }
    return res.ok;
  } catch (e) {
    console.error('Telegram sendPhoto error:', e && e.message ? e.message : e);
    return false;
  }
}

/* ---------------- PNG encoder (1-bit grayscale, stored DEFLATE) ---------------- */

// CRC-32 (IEEE) table for PNG chunks.
const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function pngCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = PNG_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// zlib stream with stored (uncompressed) DEFLATE blocks — no compression
// dependency, identical behaviour in Workers and Node. A 1-bit QR image
// stays small (~30–70 KB) even without compression.
function zlibStore(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01; // zlib header: no compression, 32K window
  let pos = 2;
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const len = Math.min(65535, raw.length - off);
    out[pos++] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00 (stored)
    out[pos++] = len & 0xFF;
    out[pos++] = (len >>> 8) & 0xFF;
    out[pos++] = (~len) & 0xFF;
    out[pos++] = ((~len) >>> 8) & 0xFF;
    out.set(raw.subarray(off, off + len), pos);
    pos += len;
    off += len;
  }
  const adler = adler32(raw);
  out[pos++] = (adler >>> 24) & 0xFF;
  out[pos++] = (adler >>> 16) & 0xFF;
  out[pos++] = (adler >>> 8) & 0xFF;
  out[pos++] = adler & 0xFF;
  return out;
}

// Renders QR modules as a 1-bit grayscale PNG. `isDark(r, c)` reads the
// module grid (row -> y, column -> x, same as the web QR Maker's drawQr).
// Quiet zone is 4 modules, like the website.
function qrPngBytes(isDark, count, scale) {
  const quiet = 4;
  const modules = count + quiet * 2;
  const width = modules * scale;
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array(width * (1 + rowBytes));
  for (let y = 0; y < width; y++) {
    const rowStart = y * (1 + rowBytes);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < rowBytes; x++) raw[rowStart + 1 + x] = 0xFF; // white (bit 1)
    const moduleRow = Math.floor(y / scale) - quiet;
    if (moduleRow < 0 || moduleRow >= count) continue;
    for (let mx = 0; mx < count; mx++) {
      if (!isDark(moduleRow, mx)) continue;
      const x0 = (mx + quiet) * scale;
      const x1 = x0 + scale;
      for (let px = x0; px < x1; px++) {
        raw[rowStart + 1 + Math.floor(px / 8)] &= ~(0x80 >>> (px % 8)); // black (bit 0)
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, width);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive (we use None per row)
  ihdr[12] = 0; // interlace: none
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = zlibStore(raw);
  const png = new Uint8Array(sig.length + (12 + 13) + (12 + idat.length) + 12);
  let p = 0;
  png.set(sig, p);
  p += sig.length;
  png.set(pngChunk('IHDR', ihdr), p);
  p += 12 + 13;
  png.set(pngChunk('IDAT', idat), p);
  p += 12 + idat.length;
  png.set(pngChunk('IEND', new Uint8Array(0)), p);
  return png;
}

// Builds the QR matrix with the vendored generator (error correction M,
// auto version — same as the website) and renders it as a PNG (~512px).
// Throws "code length overflow" when the text does not fit any QR version.
function makeQrPng(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const scale = Math.max(4, Math.floor(512 / (count + 8)));
  return qrPngBytes((r, c) => qr.isDark(r, c), count, scale);
}

/* ---------------- Telegram update handling ---------------- */

// First http(s) URL in the message, with trailing punctuation trimmed
// (users often write "ნახე https://example.com!").
function extractTelegramUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/);
  if (!m) return null;
  return m[0].replace(/[.,!?:;]+$/, '');
}

// "/qr@MiniLinkBot hello" -> { cmd: "qr", arg: "hello" }. Only a leading
// slash counts as a command; anything else is a plain message.
function telegramCommand(text) {
  if (!text.startsWith('/')) return null;
  const first = text.split(/\s+/, 1)[0];
  const cmd = first.slice(1).split('@')[0].toLowerCase();
  const arg = text.slice(first.length).trim();
  return { cmd, arg };
}

// Daily SHA-256 hash of the Telegram user id (peppered) — the raw id is
// never stored anywhere. Same pattern as the IP-hash rate limits.
async function telegramUserHash(env, userId) {
  const day = new Date().toISOString().slice(0, 10);
  return sha256Hex('tg|' + userId + '|' + day + '|' + (env.SESSION_SECRET || 'url-shortener-default-salt'));
}

// Bot QR generations join the same qr_history log the website uses, as
// anonymous rows, so the admin sees everything in one place.
async function logTelegramQr(env, payload) {
  try {
    await env.DB.prepare(
      'INSERT INTO qr_history (user_id, type, label, payload, fg, bg, favorite, created_at) VALUES (NULL, ?, ?, ?, ?, ?, 0, ?)',
    ).bind('link', 'Telegram ბოტი', payload, '#000000', '#ffffff', Date.now()).run();
  } catch { /* history log is best-effort */ }
}

async function handleTelegramWebhook(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'telegram_not_configured' }, 200);
  }
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!constantTimeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }
  const msg = update && update.message;
  if (!msg || typeof msg.text !== 'string' || !msg.chat || !msg.chat.id) return json({ ok: true });
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id ? msg.from.id : chatId;
  const text = msg.text.trim();
  if (!text) return json({ ok: true });

  const command = telegramCommand(text);
  if (command && (command.cmd === 'start' || command.cmd === 'help')) {
    await tgSendMessage(env, chatId, command.cmd === 'start' ? TG_START_TEXT : TG_HELP_TEXT);
    return json({ ok: true });
  }

  const userHash = await telegramUserHash(env, userId);

  // /qr <text> — QR code for arbitrary text, without shortening.
  // Validation runs before the rate limit so typos do not burn quota;
  // the sender is a real Telegram account, unlike the anonymous web form.
  if (command && command.cmd === 'qr') {
    if (!command.arg) {
      await tgSendMessage(env, chatId, 'დაწერე ასე:\n/qr შენი ტექსტი\n\nმაგალითად:\n/qr https://example.com');
      return json({ ok: true });
    }
    if (command.arg.length > 2048) {
      await tgSendMessage(env, chatId, 'ტექსტი ძალიან გრძელია (მაქს. 2048 სიმბოლო).');
      return json({ ok: true });
    }
    const minOk = await rateLimit(env, `tg-qr:${userHash}`, CONFIG.telegramQrMaxPerMin, 60);
    const hourOk = minOk && await rateLimit(env, `tg-qr-hour:${userHash}`, CONFIG.telegramQrMaxPerHour, 3600);
    if (!hourOk) {
      await tgSendMessage(env, chatId, '⏳ ლიმიტი ამოიწურა — QR კოდის შექმნა მოგვიანებით სცადე.');
      return json({ ok: true });
    }
    try {
      const png = makeQrPng(command.arg);
      await tgSendPhoto(env, chatId, png, 'QR კოდი ✅');
      await logTelegramQr(env, command.arg);
    } catch (e) {
      const msgText = String(e && e.message ? e.message : e);
      console.error('Telegram QR failed:', msgText);
      if (msgText.includes('code length overflow')) {
        await tgSendMessage(env, chatId, 'ტექსტი QR კოდისთვის ძალიან გრძელია — შეამოკლე და სცადე ხელახლა.');
      } else {
        await tgSendMessage(env, chatId, 'QR კოდის შექმნა ვერ მოხერხდა — სცადე ხელახლა.');
      }
    }
    return json({ ok: true });
  }

  // Any other /command: point to /help, do not shorten.
  if (command) {
    await tgSendMessage(env, chatId, 'უცნობი ბრძანება. დახმარება: /help');
    return json({ ok: true });
  }

  const rawUrl = extractTelegramUrl(text);
  if (!rawUrl) {
    await tgSendMessage(env, chatId, 'ბმული გამომიგზავნე, მაგალითად:\nhttps://example.com\n\nან QR კოდისთვის დაწერე:\n/qr შენი ტექსტი\n\nდახმარება: /help');
    return json({ ok: true });
  }
  // Same strict validation as the public web form (https only, no IPs,
  // no localhost, no other shorteners, no self-redirects, blocklists).
  const v = validateDestination(rawUrl, ownHosts(request));
  if (!v.ok) {
    await tgSendMessage(env, chatId, v.reason + '\n\nმაგალითად:\nhttps://example.com');
    return json({ ok: true });
  }
  const minOk = await rateLimit(env, `tg-create:${userHash}`, CONFIG.telegramMaxPerMin, 60);
  const hourOk = minOk && await rateLimit(env, `tg-create-hour:${userHash}`, CONFIG.telegramMaxPerHour, 3600);
  if (!hourOk) {
    await tgSendMessage(env, chatId, '⏳ ლიმიტი ამოიწურა — საათში 10 ბმული შეიძლება. სცადე მოგვიანებით.');
    return json({ ok: true });
  }
  const alias = await insertAutoLink(env, v.url, null, null, 'Telegram');
  if (!alias) {
    await tgSendMessage(env, chatId, 'ბმულის შექმნა ვერ მოხერხდა — სცადე ხელახლა.');
    return json({ ok: true });
  }
  const shortUrl = publicLink(request, alias);
  await tgSendMessage(env, chatId, '✅ მზადაა!\n\n🔗 ' + shortUrl + '\n\nორიგინალი:\n' + v.url);
  try {
    const png = makeQrPng(shortUrl);
    await tgSendPhoto(env, chatId, png, '🔗 ' + shortUrl);
    await logTelegramQr(env, shortUrl);
  } catch (e) {
    // The short link was already delivered — a QR failure never blocks it.
    console.error('Telegram QR failed:', e && e.message ? e.message : e);
  }
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Admin chat (v7.0; redesigned v7.1; R2 file storage in v7.3)       */
/*                                                                     */
/* One thread per user (chat_threads.user_id UNIQUE). The chat is      */
/* visible ONLY to email-verified users — the gate is enforced         */
/* server-side on every chat route, not by hiding UI. Users send       */
/* TEXT only; the admin sends text + photos + files. Messages are      */
/* plain text (chat_messages has NO blob column, so listing them       */
/* never touches file bytes). Since v7.3, attachment BYTES live in    */
/* the private R2 bucket (env.CHAT_FILES, unguessable chat/ keys)      */
/* and D1 keeps only metadata + the r2_key — D1 blobs proved           */
/* unreliable on real D1 (bytes came back corrupt). Rows from          */
/* v7.0/v7.1 keep their legacy D1 `data` blob and are still served     */
/* by the old path. Attachments are capped at 5 MB decoded.            */
/* ------------------------------------------------------------------ */

// File types an admin may attach. Executables, HTML, SVG and everything
// else are blocked — a served attachment can never run as a page
// (Content-Type comes from this allowlist + nosniff on download).
const CHAT_ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'application/zip',
]);

function sanitizeChatFileName(raw) {
  let name = String(raw || '').trim();
  // Strip path separators, control characters and shell-sensitive chars.
  name = name.replace(/[/\\?%*:|"<>]/g, '_').replace(/[\x00-\x1F\x7F]/g, '');
  // Collapse dot runs (".." can never appear) and strip leading dots
  // (hidden files) — the name can never be or contain a path traversal.
  name = name.replace(/\.{2,}/g, '.').replace(/^\.+/, '');
  if (!name) name = 'file';
  if (name.length > 100) name = name.slice(0, 100);
  return name;
}

// Validates an attachment sent as { fileName, mimeType, dataBase64 }.
// Returns { ok: true, attachment: null } when no attachment was sent,
// { ok: true, attachment: { fileName, mimeType, bytes, sizeBytes } },
// or { ok: false, reason }. The decoded size is capped at 5 MB
// (CONFIG.chatMaxAttachmentBytes; bytes go to R2 since v7.3).
function validateChatAttachment(raw) {
  if (raw === undefined || raw === null) return { ok: true, attachment: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'დანართი არასწორია.' };
  }
  const mimeType = String(raw.mimeType || '').toLowerCase().trim();
  if (!CHAT_ALLOWED_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: 'ფაილის ტიპი დაუშვებელია — სურათი, PDF, ტექსტი ან ZIP შეიძლება.' };
  }
  let b64 = String(raw.dataBase64 || '').trim();
  // Tolerate a data: URL prefix (some clients send the whole data URL).
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma === -1) return { ok: false, reason: 'ფაილი არასწორია.' };
    b64 = b64.slice(comma + 1);
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) return { ok: false, reason: 'ფაილი ცარიელია.' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, reason: 'ფაილი არასწორია.' };
  }
  // Cheap pre-check before decoding: base64 inflates by ~4/3. The
  // padding chars carry no bytes, so subtract them — otherwise a
  // file of exactly the limit is wrongly rejected.
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if (Math.floor(b64.length * 3 / 4) - pad > CONFIG.chatMaxAttachmentBytes) {
    return { ok: false, reason: 'ფაილი ძალიან დიდია (მაქს. 5 MB).' };
  }
  let bytes;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return { ok: false, reason: 'ფაილი არასწორია.' };
  }
  if (bytes.length === 0) return { ok: false, reason: 'ფაილი ცარიელია.' };
  if (bytes.length > CONFIG.chatMaxAttachmentBytes) {
    return { ok: false, reason: 'ფაილი ძალიან დიდია (მაქს. 5 MB).' };
  }
  return {
    ok: true,
    attachment: {
      fileName: sanitizeChatFileName(raw.fileName),
      mimeType,
      bytes,
      sizeBytes: bytes.length,
    },
  };
}

// Validates a URL the admin sends from the chat "+" menu ("ლინკი").
// Lighter than the link-shortening validator: https only, well-formed,
// no credentials. The URL is stored as the message text itself.
// Returns { ok: true, url: null } when no link was sent,
// { ok: true, url } with the trimmed URL, or { ok: false, reason }.
function validateChatLinkUrl(raw) {
  if (raw === undefined || raw === null) return { ok: true, url: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'ლინკი არასწორია.' };
  const value = raw.trim();
  if (!value) return { ok: true, url: null };
  if (value.length > CONFIG.chatMaxBodyChars) {
    return { ok: false, reason: 'ლინკი ძალიან გრძელია.' };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'ლინკი არასწორია — სრული https მისამართი ჩაწერეთ.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'მხოლოდ https ლინკი შეიძლება.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'ლინკში მომხმარებლის სახელი/პაროლი არ შეიძლება.' };
  }
  if (!parsed.hostname) return { ok: false, reason: 'ლინკი არასწორია.' };
  return { ok: true, url: value };
}

async function getOrCreateChatThread(env, userId) {
  const existing = await env.DB.prepare(
    'SELECT id, user_id, created_at, last_message_at, admin_unread, user_unread FROM chat_threads WHERE user_id = ?',
  ).bind(userId).first();
  if (existing) return existing;
  const now = Date.now();
  try {
    const ins = await env.DB.prepare(
      'INSERT INTO chat_threads (user_id, created_at, last_message_at, admin_unread, user_unread) VALUES (?, ?, ?, 0, 0)',
    ).bind(userId, now, now).run();
    if (ins.success) {
      return { id: ins.meta.last_row_id, user_id: userId, created_at: now, last_message_at: now, admin_unread: 0, user_unread: 0 };
    }
  } catch (e) {
    // UNIQUE race: another request created the thread first — fall
    // through to the SELECT below. Any other error is rethrown.
    if (!String(e && e.message ? e.message : e).includes('UNIQUE')) throw e;
  }
  return await env.DB.prepare(
    'SELECT id, user_id, created_at, last_message_at, admin_unread, user_unread FROM chat_threads WHERE user_id = ?',
  ).bind(userId).first();
}

// One message + its attachment METADATA (never the blob bytes — the
// data column is selected only by the download endpoint).
function chatMessageToJson(row) {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    createdAt: row.created_at,
    attachment: row.att_id ? {
      id: row.att_id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      url: '/api/chat/attachment?id=' + row.att_id,
    } : null,
  };
}

// Messages of one thread, oldest first. With after > 0 (polling) only
// messages newer than that id are returned; otherwise the newest 100.
async function listChatMessages(env, threadId, after) {
  const cols = 'm.id, m.sender, m.body, m.created_at, a.id AS att_id, a.file_name, a.mime_type, a.size_bytes';
  const from = 'chat_messages m LEFT JOIN chat_attachments a ON a.message_id = m.id';
  let rows;
  if (after > 0) {
    rows = await env.DB.prepare(
      `SELECT ${cols} FROM ${from} WHERE m.thread_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`,
    ).bind(threadId, after, CONFIG.chatMaxMessages).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT ${cols} FROM ${from} WHERE m.thread_id = ? ORDER BY m.id DESC LIMIT ?`,
    ).bind(threadId, CONFIG.chatMaxMessages).all();
    (rows.results || []).reverse();
  }
  return (rows.results || []).map(chatMessageToJson);
}

// Inserts a message (+ optional attachment row) and bumps the OTHER
// side's unread counter + the thread's last_message_at. Since v7.3,
// attachment bytes go to the private R2 bucket (unguessable chat/
// key) BEFORE the D1 row is written; D1 keeps metadata + r2_key and
// an empty `data` placeholder (the column is NOT NULL in the v7
// schema). If the R2 binding is missing, this THROWS — attachments
// must never silently fall back to D1 blobs (that round-trip proved
// corrupt on real D1). Callers with attachments check the binding
// first and return a clear error instead.
async function insertChatMessage(env, thread, sender, body, attachment) {
  const now = Date.now();
  // Upload FIRST: a failed R2 put must not leave an orphan message
  // row behind. The row insert below only runs once bytes are stored.
  let r2Key = null;
  if (attachment) {
    if (!env.CHAT_FILES) {
      throw new Error('R2 bucket is not bound (CHAT_FILES).');
    }
    r2Key = 'chat/' + crypto.randomUUID();
    await env.CHAT_FILES.put(r2Key, attachment.bytes, {
      httpMetadata: { contentType: attachment.mimeType },
    });
  }
  const ins = await env.DB.prepare(
    'INSERT INTO chat_messages (thread_id, sender, body, created_at) VALUES (?, ?, ?, ?)',
  ).bind(thread.id, sender, body, now).run();
  const messageId = ins.meta.last_row_id;
  let attJson = null;
  if (attachment) {
    let ains;
    try {
      ains = await env.DB.prepare(
        "INSERT INTO chat_attachments (message_id, file_name, mime_type, size_bytes, data, r2_key) VALUES (?, ?, ?, ?, x'', ?)",
      ).bind(messageId, attachment.fileName, attachment.mimeType, attachment.sizeBytes, r2Key).run();
    } catch (e) {
      // Don't orphan the R2 object if the row insert fails.
      try { await env.CHAT_FILES.delete(r2Key); } catch { /* best-effort */ }
      throw e;
    }
    attJson = {
      id: ains.meta.last_row_id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      url: '/api/chat/attachment?id=' + ains.meta.last_row_id,
    };
  }
  const unreadCol = sender === 'admin' ? 'user_unread' : 'admin_unread';
  await env.DB.prepare(
    `UPDATE chat_threads SET last_message_at = ?, ${unreadCol} = ${unreadCol} + 1 WHERE id = ?`,
  ).bind(now, thread.id).run();
  return { id: messageId, sender, body, createdAt: now, attachment: attJson };
}

/* ------------------------------------------------------------------ */
/* Profile pages (v8.0) — public Linktree-style pages at /@username    */
/*                                                                     */
/* A profile is created EXPLICITLY by a logged-in, email-verified      */
/* user (the gate is enforced server-side, like the chat gate).        */
/* Before creation, /@username shows a friendly "not created yet"      */
/* page (404). The page is PUBLIC by design: anyone with the link      */
/* sees the avatar, display name, bio and the user's MANUALLY chosen   */
/* buttons — shortened links are NEVER auto-published here.            */
/*                                                                     */
/* Avatars live in the same private R2 bucket as chat files            */
/* (env.CHAT_FILES), under unguessable avatars/ keys, and are served   */
/* publicly via GET /@username/avatar (the route checks the profile,   */
/* not a session). The view counter increments atomically on every     */
/* public render; the owner toggles its visibility in settings.        */
/*                                                                     */
/* All user content is escaped when the page is rendered               */
/* (escapeHtml) — the template never interpolates raw user text.       */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Avatar image types. GIF is excluded on purpose (animation + size);
// the client compresses to JPEG before upload.
const PROFILE_AVATAR_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp',
]);

// Validates an avatar sent as { mimeType, dataBase64 } — the same shape
// as chat attachments (see validateChatAttachment). The decoded size
// is capped at 2 MB (CONFIG.profileAvatarMaxBytes). Returns
// { ok: true, avatar: { mimeType, bytes, sizeBytes } } or { ok: false, reason }.
function validateProfileAvatar(raw) {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'ფოტო არ არის არჩეული.' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'ფოტო არასწორია.' };
  }
  const mimeType = String(raw.mimeType || '').toLowerCase().trim();
  if (!PROFILE_AVATAR_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: 'ფოტოს ტიპი დაუშვებელია — PNG, JPEG ან WebP შეიძლება.' };
  }
  let b64 = String(raw.dataBase64 || '').trim();
  // Tolerate a data: URL prefix (some clients send the whole data URL).
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma === -1) return { ok: false, reason: 'ფოტო არასწორია.' };
    b64 = b64.slice(comma + 1);
  }
  b64 = b64.replace(/\s+/g, '');
  if (!b64) return { ok: false, reason: 'ფოტო ცარიელია.' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return { ok: false, reason: 'ფოტო არასწორია.' };
  }
  // Cheap pre-check before decoding: base64 inflates by ~4/3. The
  // padding chars carry no bytes, so subtract them — otherwise a
  // file of exactly the limit is wrongly rejected.
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if (Math.floor(b64.length * 3 / 4) - pad > CONFIG.profileAvatarMaxBytes) {
    return { ok: false, reason: 'ფოტო ძალიან დიდია (მაქს. 2 MB).' };
  }
  let bytes;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return { ok: false, reason: 'ფოტო არასწორია.' };
  }
  if (bytes.length === 0) return { ok: false, reason: 'ფოტო ცარიელია.' };
  if (bytes.length > CONFIG.profileAvatarMaxBytes) {
    return { ok: false, reason: 'ფოტო ძალიან დიდია (მაქს. 2 MB).' };
  }
  return { ok: true, avatar: { mimeType, bytes, sizeBytes: bytes.length } };
}

// Validates a hand-typed profile link URL. Reuses the chat-link
// validator (https only, well-formed, no credentials) and additionally
// blocks localhost / internal / IP-literal hosts — a public profile
// button must never point at a private address.
function validateProfileManualUrl(raw) {
  const lv = validateChatLinkUrl(raw);
  if (!lv.ok) return lv;
  if (!lv.url) return { ok: false, reason: 'ლინკი ცარიელია.' };
  let host;
  try {
    host = new URL(lv.url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'ლინკი არასწორია — სრული https მისამართი ჩაწერეთ.' };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa') ||
      isIPv4(host) || isIPv6(host)) {
    return { ok: false, reason: 'ლოკალური/შიდა მისამართები დაუშვებელია.' };
  }
  return { ok: true, url: lv.url };
}

// One trimmed text field with a length cap. `allowEmpty` keeps '' legal
// (bio); otherwise an empty value is an error (display name, title).
function validateProfileText(raw, max, label, allowEmpty) {
  if (typeof raw !== 'string') return { ok: false, reason: label + ' ტექსტი უნდა იყოს.' };
  const value = raw.trim();
  if (!allowEmpty && !value) return { ok: false, reason: label + ' შეიყვანეთ.' };
  if (value.length > max) return { ok: false, reason: `${label} მაქს. ${max} სიმბოლო შეიძლება იყოს.` };
  return { ok: true, value };
}

// Profile + user in one row, by username (case-insensitive — /@NIKA
// finds nika). profile_user_id is NULL when the user never created a
// profile; the whole row is NULL when the username does not exist.
async function getProfileByUsername(env, username) {
  return env.DB.prepare(
    'SELECT u.id AS user_id, u.username, u.disabled, ' +
    'p.user_id AS profile_user_id, p.display_name, p.bio, p.avatar_r2_key, p.avatar_mime, ' +
    'p.show_views, p.link_limit, p.view_count ' +
    'FROM users u LEFT JOIN profiles p ON p.user_id = u.id ' +
    'WHERE u.username = ? COLLATE NOCASE',
  ).bind(username).first();
}

// The user's buttons in display order. Short-link rows carry their
// alias (NULL when the underlying link was deleted — the public page
// skips those, the editor shows them as deleted).
async function listProfileLinks(env, userId) {
  const rows = await env.DB.prepare(
    'SELECT pl.id, pl.position, pl.kind, pl.link_id, pl.title, pl.url, l.alias ' +
    'FROM profile_links pl LEFT JOIN links l ON l.id = pl.link_id ' +
    'WHERE pl.user_id = ? ORDER BY pl.position ASC, pl.id ASC',
  ).bind(userId).all();
  return rows.results || [];
}

function profileLinkToJson(request, row) {
  const isShort = row.kind === 'short';
  return {
    id: row.id,
    kind: row.kind,
    position: row.position,
    title: row.title,
    url: isShort ? (row.alias ? publicLink(request, row.alias) : null) : row.url,
    alias: isShort ? (row.alias || null) : null,
    linkId: row.link_id || null,
    missing: isShort && !row.alias,
  };
}

function profileToJson(request, username, profileRow, linkRows) {
  const hasAvatar = !!profileRow.avatar_r2_key;
  return {
    username,
    displayName: profileRow.display_name,
    bio: profileRow.bio,
    hasAvatar,
    avatarUrl: hasAvatar ? '/@' + username + '/avatar' : null,
    showViews: profileRow.show_views === 1,
    linkLimit: profileRow.link_limit,
    viewCount: profileRow.view_count,
    linkCount: linkRows.length,
    links: linkRows.map((r) => profileLinkToJson(request, r)),
  };
}

/* ---------------- Public profile page template ---------------- */

// Pure function: builds the whole page as one HTML string. Every
// user-controlled value goes through escapeHtml; hrefs are rendered
// only when they start with https:// (validated at write time, checked
// again here). Vivid lilac + heavy glass: brighter aurora glows and
// stronger blur/saturate than the main site, per the v8.0 design brief.
function renderProfilePage(data) {
  const name = escapeHtml(data.displayName || data.username);
  const handle = escapeHtml('@' + data.username);
  const bio = escapeHtml(data.bio || '');
  const initial = escapeHtml((data.displayName || data.username || '?').trim().charAt(0).toUpperCase() || '?');
  const avatarUrl = '/@' + encodeURIComponent(data.username) + '/avatar';
  const buttons = data.links
    .filter((l) => typeof l.href === 'string' && l.href.startsWith('https://'))
    .map((l) => '    <a class="plink" href="' + escapeHtml(l.href) + '" target="_blank" rel="noopener">' + escapeHtml(l.title) + '</a>')
    .join('\n');
  const views = data.showViews
    ? '  <p class="views">👁 ' + Number(data.viewCount || 0) + ' ნახვა</p>\n'
    : '';
  return '<!DOCTYPE html>\n' +
'<html lang="ka">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
'<meta name="description" content="' + handle + ' — Mini Link პროფილი">\n' +
'<title>' + name + ' — Mini Link</title>\n' +
'<style>\n' +
':root{color-scheme:dark}\n' +
'*{box-sizing:border-box}\n' +
'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Georgian",sans-serif;color:#fff;line-height:1.5;min-height:100vh;' +
'background-color:#0d0620;' +
'background-image:radial-gradient(600px 380px at 8% -60px,rgba(56,189,248,.50),transparent 70%),radial-gradient(560px 360px at 98% 6%,rgba(232,121,249,.45),transparent 70%),radial-gradient(720px 480px at 50% 118%,rgba(124,58,237,.55),transparent 72%),radial-gradient(420px 300px at 85% 55%,rgba(168,85,247,.35),transparent 70%),radial-gradient(380px 280px at 10% 60%,rgba(96,165,250,.30),transparent 70%);' +
'background-attachment:fixed;background-repeat:no-repeat}\n' +
'.wrap{max-width:480px;margin:0 auto;padding:30px 16px 48px;text-align:center}\n' +
'.avatar{width:112px;height:112px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.35);box-shadow:0 0 0 1px rgba(216,180,254,.35),0 10px 30px rgba(0,0,0,.4),0 0 42px rgba(168,85,247,.5);background:rgba(255,255,255,.12)}\n' +
'.initials{width:112px;height:112px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:3rem;font-weight:800;border:1px solid rgba(255,255,255,.4);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 10px 30px rgba(0,0,0,.4),0 0 42px rgba(168,85,247,.5);background:linear-gradient(180deg,rgba(255,255,255,.25),rgba(255,255,255,.08));-webkit-backdrop-filter:blur(16px) saturate(1.6);backdrop-filter:blur(16px) saturate(1.6)}\n' +
'h1{margin:14px 0 2px;font-size:1.6rem;font-weight:800;letter-spacing:-.01em;word-break:break-word;text-shadow:0 2px 14px rgba(0,0,0,.5)}\n' +
'.handle{margin:0 0 10px;color:#e9d5ff;text-shadow:0 1px 10px rgba(0,0,0,.45)}\n' +
'.bio{margin:0 0 22px;color:#f3e8ff;white-space:pre-wrap;word-break:break-word;text-shadow:0 1px 10px rgba(0,0,0,.45)}\n' +
'.plink{display:block;padding:15px 18px;margin:0 0 12px;border-radius:999px;text-decoration:none;color:#fff;font-weight:650;word-break:break-word;' +
'background-image:radial-gradient(160px 56px at 18% -12px,rgba(255,255,255,.38),transparent 70%),linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,.06)),linear-gradient(135deg,rgba(56,189,248,.18),rgba(168,85,247,.24) 55%,rgba(232,121,249,.18));' +
'background-color:rgba(30,16,60,.32);' +
'-webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8);' +
'border:1px solid rgba(255,255,255,.38);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),inset 0 -1px 0 rgba(255,255,255,.10),0 10px 28px rgba(0,0,0,.35),0 0 24px rgba(168,85,247,.30);transition:filter .15s ease,box-shadow .15s ease,transform .15s ease}\n' +
'.plink:hover{filter:brightness(1.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.55),inset 0 -1px 0 rgba(255,255,255,.12),0 12px 30px rgba(0,0,0,.4),0 0 34px rgba(168,85,247,.45)}\n' +
'.plink:active{transform:scale(.98)}\n' +
'.empty{color:#e9d5ff;margin:0 0 12px}\n' +
'.views{display:inline-block;padding:6px 14px;border-radius:999px;color:#e9d5ff;margin:20px 0 0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);-webkit-backdrop-filter:blur(12px) saturate(1.5);backdrop-filter:blur(12px) saturate(1.5);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 6px 18px rgba(0,0,0,.3)}\n' +
'footer{margin-top:30px;color:#d8b4fe;font-size:.9rem}\n' +
'footer a{color:#fff}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<main class="wrap">\n' +
(data.hasAvatar
  ? '  <img class="avatar" src="' + avatarUrl + '" alt="">\n'
  : '  <span class="initials">' + initial + '</span>\n') +
'  <h1>' + name + '</h1>\n' +
'  <p class="handle">' + handle + '</p>\n' +
(bio ? '  <p class="bio">' + bio + '</p>\n' : '') +
(buttons || '  <p class="empty">ბმულები ჯერ არ დაუმატებია.</p>\n') +
views +
'  <footer>შექმნილია <a href="/">Mini Link</a>-ით — minilink.space</footer>\n' +
'</main>\n' +
'</body>\n' +
'</html>\n';
}

// Friendly 404 page in the same visual shell: unknown username, or a
// user who never created a profile. Both stay 404 (no profile exists
// to show), but the message differs so the visitor knows which it is.
function renderProfileMessagePage(title, message) {
  return '<!DOCTYPE html>\n' +
'<html lang="ka">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
'<title>' + escapeHtml(title) + ' — Mini Link</title>\n' +
'<style>\n' +
':root{color-scheme:dark}\n' +
'*{box-sizing:border-box}\n' +
'body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Georgian",sans-serif;color:#fff;line-height:1.5;min-height:100vh;' +
'background-color:#0d0620;' +
'background-image:radial-gradient(600px 380px at 8% -60px,rgba(56,189,248,.50),transparent 70%),radial-gradient(560px 360px at 98% 6%,rgba(232,121,249,.45),transparent 70%),radial-gradient(720px 480px at 50% 118%,rgba(124,58,237,.55),transparent 72%),radial-gradient(420px 300px at 85% 55%,rgba(168,85,247,.35),transparent 70%),radial-gradient(380px 280px at 10% 60%,rgba(96,165,250,.30),transparent 70%);' +
'background-attachment:fixed;background-repeat:no-repeat}\n' +
'.wrap{max-width:480px;margin:0 auto;padding:60px 16px 48px;text-align:center}\n' +
'h1{font-size:1.4rem;margin:0 0 10px}\n' +
'p{color:#e9d5ff}\n' +
'a{color:#fff}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<main class="wrap">\n' +
'  <h1>' + escapeHtml(title) + '</h1>\n' +
'  <p>' + escapeHtml(message) + '</p>\n' +
'  <p><a href="/">მთავარ გვერდზე დაბრუნება</a></p>\n' +
'</main>\n' +
'</body>\n' +
'</html>\n';
}

async function handleProfilePage(request, env, username) {
  await ensureV9Schema(env);
  const row = await getProfileByUsername(env, username);
  if (!row || row.disabled === 1) {
    return new Response(
      renderProfileMessagePage('მომხმარებელი არ მოიძებნა', '@' + username + ' — ასეთი მომხმარებელი არ არსებობს.'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  if (!row.profile_user_id) {
    return new Response(
      renderProfileMessagePage('პროფილი ჯერ არ არის შექმნილი', '@' + row.username + '-ს ჯერ პროფილი არ შეუქმნია.'),
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  // Atomic view increment (single UPDATE). A failed increment never
  // blocks the page — availability first, like link click counting.
  let viewCount = row.view_count || 0;
  try {
    await env.DB.prepare(
      'UPDATE profiles SET view_count = view_count + 1 WHERE user_id = ?',
    ).bind(row.user_id).run();
    viewCount += 1;
  } catch (e) {
    console.error('profile view increment failed:', e && e.message ? e.message : e);
  }
  const linkRows = await listProfileLinks(env, row.user_id);
  const links = linkRows
    .map((r) => profileLinkToJson(request, r))
    .filter((l) => !l.missing && l.url)
    .map((l) => ({ title: l.title, href: l.url }));
  return new Response(renderProfilePage({
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    hasAvatar: !!row.avatar_r2_key,
    showViews: row.show_views === 1,
    viewCount,
    links,
  }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Serves the profile avatar publicly (no session — the profile page is
// public). Content-Type comes from the stored allowlisted mime type +
// nosniff, so a stored file can never run as a page.
async function handleProfileAvatar(request, env, username) {
  await ensureV9Schema(env);
  const row = await getProfileByUsername(env, username);
  if (!row || row.disabled === 1 || !row.profile_user_id || !row.avatar_r2_key) {
    return new Response('Not found', { status: 404 });
  }
  if (!env.CHAT_FILES) return error('ფაილების საცავი მიუწვდომელია.', 500);
  const obj = await env.CHAT_FILES.get(row.avatar_r2_key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(await obj.arrayBuffer(), {
    headers: {
      'Content-Type': row.avatar_mime || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/* ------------------------------------------------------------------ */
/* Static frontend (ASSETS binding, or embedded copy in single-file build) */
/* ------------------------------------------------------------------ */

const STATIC_TYPES = {
  '/index.html': 'text/html; charset=utf-8',
  '/admin.html': 'text/html; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/public.js': 'text/javascript; charset=utf-8',
  '/auth.js': 'text/javascript; charset=utf-8',
  '/qr-maker.js': 'text/javascript; charset=utf-8',
  '/qrcode.min.js': 'text/javascript; charset=utf-8',
  '/favicon.ico': 'image/x-icon',
};

// Files that exist only for the admin panel — never served on the public host.
const ADMIN_ONLY_FILES = new Set(['/admin.html', '/app.js']);

async function serveStatic(env, request, pathname) {
  // The homepage depends on the hostname: the public host shows the public
  // shorten form; admin hosts (admin.minilink.space, *.workers.dev) show the
  // admin login + dashboard.
  const file = pathname === '/' ? (isAdminHost(request) ? '/admin.html' : '/index.html') : pathname;
  if (!STATIC_TYPES[file]) return null; // not a known static file
  if (ADMIN_ONLY_FILES.has(file) && !isAdminHost(request)) return null; // admin file on public host -> 404
  const embedded = EMBEDDED_FILES[file];
  if (embedded) {
    return new Response(embedded.body, {
      headers: { 'Content-Type': embedded.type, 'Cache-Control': 'public, max-age=3600' },
    });
  }
  if (env.ASSETS) {
    // NOTE: fetch the COMPUTED file, not the original request URL — for '/'
    // the file depends on the hostname (index.html vs admin.html), and the
    // ASSETS binding serves by request path, so passing the original request
    // would always serve index.html on every host.
    const assetUrl = new URL(request.url);
    assetUrl.pathname = file;
    let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    // Static Assets redirects ".html" URLs to clean extensionless paths
    // (e.g. /admin.html -> /admin, /index.html -> /). If we returned that
    // 307 to the client, "/" would redirect to itself forever — so follow
    // the redirect INSIDE the Worker and return the final content.
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops < 3) {
      const loc = res.headers.get('Location');
      if (!loc) break;
      const nextUrl = new URL(loc, assetUrl);
      res = await env.ASSETS.fetch(new Request(nextUrl.toString(), request));
      hops++;
    }
    if (res.status === 404) return new Response('Not found', { status: 404 });
    return res;
  }
  return new Response('Not found', { status: 404 });
}

/* ------------------------------------------------------------------ */
/* Redirects (public)                                                  */
/* ------------------------------------------------------------------ */

function isBot(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  return BOT_UA.some((frag) => ua.includes(frag));
}

// v10.1: loose IP validation for the admin-managed exclusion list.
// IPv4 = four decimal octets (each <= 255); IPv6 = hex groups + colons
// (compressed forms allowed). Anything else is rejected. The value is
// only ever used as a bind parameter and shown via textContent.
function isValidIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every((o) => Number(o) <= 255);
  }
  return /^[0-9A-Fa-f:]+$/.test(ip) && ip.includes(':') && !ip.includes(':::');
}

// v10.3: parse a User-Agent into browser/OS/device. Only the parsed
// values are stored — the raw User-Agent string never is.
function parseUserAgent(ua) {
  const s = ua || '';
  let browser = null;
  let m;
  if ((m = s.match(/Edg\/(\d+)/))) browser = 'Edge ' + m[1];
  else if ((m = s.match(/OPR\/(\d+)/))) browser = 'Opera ' + m[1];
  else if ((m = s.match(/SamsungBrowser\/(\d+)/))) browser = 'Samsung ' + m[1];
  else if ((m = s.match(/FxiOS\/(\d+)/))) browser = 'Firefox ' + m[1];
  else if ((m = s.match(/CriOS\/(\d+)/))) browser = 'Chrome ' + m[1];
  else if ((m = s.match(/Firefox\/(\d+)/))) browser = 'Firefox ' + m[1];
  else if ((m = s.match(/Chrome\/(\d+)/))) browser = 'Chrome ' + m[1];
  else if ((m = s.match(/Version\/(\d+).*Safari\//))) browser = 'Safari ' + m[1];
  else if (/MSIE|Trident\//.test(s)) browser = 'Internet Explorer';
  let os = null;
  if ((m = s.match(/Android (\d+(?:\.\d+)?)/))) os = 'Android ' + m[1];
  else if (/Android/.test(s)) os = 'Android';
  else if ((m = s.match(/OS (\d+)[_.](\d+)/)) && /(iPhone|iPad|iPod)/.test(s)) os = 'iOS ' + m[1] + '.' + m[2];
  else if (/(iPhone|iPad|iPod)/.test(s)) os = 'iOS';
  else if (/Windows NT 10\.0/.test(s)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/.test(s)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/.test(s)) os = 'Windows 7';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if ((m = s.match(/Mac OS X (\d+)[_.](\d+)/))) os = 'macOS ' + m[1] + '.' + m[2];
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let device = null;
  if (/iPad/.test(s) || /Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = 'tablet';
  else if (/Mobile|iPhone|iPod|Android/.test(s)) device = 'mobile';
  else if (s) device = 'desktop';
  return { browser, os, device };
}

// Georgia is UTC+4 year-round (no DST since 2004), so a fixed offset
// gives Tbilisi-local day/hour for the visit-hours histogram.
function tbilisiDayHour(now) {
  const shifted = now + 4 * 3600 * 1000;
  const day = new Date(shifted).toISOString().slice(0, 10);
  const hour = new Date(shifted).getUTCHours();
  const cutoffDay = new Date(shifted - 30 * 86400000).toISOString().slice(0, 10);
  return { day, hour, cutoffDay };
}

// Referrer origin only (scheme + host) — the full URL can carry
// sensitive query params from the referring page, and the origin is
// what answers "where did the traffic come from".
function referrerOrigin(request) {
  const ref = request.headers.get('Referer');
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.slice(0, 200);
  } catch {
    return null;
  }
}

function primaryLanguage(request) {
  const al = request.headers.get('Accept-Language');
  if (!al) return null;
  const tag = al.split(',')[0].split(';')[0].trim();
  return tag ? tag.slice(0, 10) : null;
}

/* v10.0: visitor IP log (admin-only, 30-day retention). The owner asked
   for this explicitly (2026-11-13): every non-bot visit to a document
   page, a profile page, or a short-link redirect upserts one row per IP
   (visit count + first/last seen + last path). Raw IPs live ONLY in the
   visitors table and are served ONLY to the admin session; no public
   endpoint ever returns them. Rows older than
   CONFIG.visitorRetentionMs are pruned on every recorded visit.
   recordVisit never throws — a logging failure must never break the
   visitor's response. */
async function recordVisit(env, request, path) {
  try {
    const ua = request.headers.get('User-Agent');
    if (isBot(ua)) return;
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || ip === 'unknown' || ip.length > 45) return;
    const now = Date.now();
    const cleanPath = String(path || '/').slice(0, 200);
    await ensureV10Schema(env);
    await ensureV11Schema(env);
    await ensureV12Schema(env);
    await ensureV13Schema(env);
    // v10.1: admin-excluded IPs are never recorded.
    const excluded = await env.DB.prepare(
      'SELECT 1 AS x FROM ip_exclusions WHERE ip = ?',
    ).bind(ip).first();
    if (excluded) return;
    // v10.2: link the visit to the logged-in user, if any (anonymous
    // visits simply have no mapping row).
    let userId = null;
    try {
      const userSession = await getUserSession(env, request);
      if (userSession) userId = userSession.userId;
    } catch { /* treat as anonymous */ }
    // v10.3: edge enrichment (Cloudflare request.cf — free, no third
    // party) + parsed device info + language + referrer origin. Raw
    // User-Agent is never stored, only the parsed browser/OS/device.
    // COALESCE keeps the last KNOWN value when a field is missing.
    const cf = request.cf || {};
    const parsed = parseUserAgent(ua);
    const country = (typeof cf.country === 'string' && cf.country) || request.headers.get('CF-IPCountry') || null;
    const e = {
      country: country ? String(country).slice(0, 2) : null,
      city: typeof cf.city === 'string' && cf.city ? cf.city.slice(0, 100) : null,
      region: typeof cf.region === 'string' && cf.region ? cf.region.slice(0, 100) : null,
      postalCode: typeof cf.postalCode === 'string' && cf.postalCode ? cf.postalCode.slice(0, 20) : null,
      latitude: typeof cf.latitude === 'number' ? cf.latitude : null,
      longitude: typeof cf.longitude === 'number' ? cf.longitude : null,
      timezone: typeof cf.timezone === 'string' && cf.timezone ? cf.timezone.slice(0, 50) : null,
      isp: typeof cf.asOrganization === 'string' && cf.asOrganization ? cf.asOrganization.slice(0, 100) : null,
      asn: typeof cf.asn === 'number' ? cf.asn : null,
      isEu: typeof cf.isEUCountry === 'boolean' ? (cf.isEUCountry ? 1 : 0) : null,
      browser: parsed.browser,
      os: parsed.os,
      device: parsed.device,
      language: primaryLanguage(request),
      referrer: referrerOrigin(request),
    };
    const { day, hour, cutoffDay } = tbilisiDayHour(now);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO visitors (ip, visits, first_seen, last_seen, last_path, country, city, region, postal_code, latitude, longitude, timezone, isp, asn, is_eu, browser, os, device, language, referrer) ' +
        'VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(ip) DO UPDATE SET visits = visits + 1, last_seen = excluded.last_seen, last_path = excluded.last_path, ' +
        'country = COALESCE(excluded.country, country), city = COALESCE(excluded.city, city), region = COALESCE(excluded.region, region), ' +
        'postal_code = COALESCE(excluded.postal_code, postal_code), latitude = COALESCE(excluded.latitude, latitude), ' +
        'longitude = COALESCE(excluded.longitude, longitude), timezone = COALESCE(excluded.timezone, timezone), isp = COALESCE(excluded.isp, isp), ' +
        'asn = COALESCE(excluded.asn, asn), is_eu = COALESCE(excluded.is_eu, is_eu), browser = COALESCE(excluded.browser, browser), ' +
        'os = COALESCE(excluded.os, os), device = COALESCE(excluded.device, device), language = COALESCE(excluded.language, language), ' +
        'referrer = COALESCE(excluded.referrer, referrer)',
      ).bind(ip, now, now, cleanPath, e.country, e.city, e.region, e.postalCode, e.latitude, e.longitude, e.timezone, e.isp, e.asn, e.isEu, e.browser, e.os, e.device, e.language, e.referrer),
      env.DB.prepare(
        'DELETE FROM visitors WHERE last_seen < ?',
      ).bind(now - CONFIG.visitorRetentionMs),
      env.DB.prepare(
        'DELETE FROM visitor_users WHERE last_seen < ?',
      ).bind(now - CONFIG.visitorRetentionMs),
      ...(userId ? [env.DB.prepare(
        'INSERT INTO visitor_users (ip, user_id, last_seen) VALUES (?, ?, ?) ' +
        'ON CONFLICT(ip, user_id) DO UPDATE SET last_seen = excluded.last_seen',
      ).bind(ip, userId, now)] : []),
      env.DB.prepare(
        'INSERT INTO visit_hours (day, hour, visits) VALUES (?, ?, 1) ' +
        'ON CONFLICT(day, hour) DO UPDATE SET visits = visits + 1',
      ).bind(day, hour),
      env.DB.prepare(
        'DELETE FROM visit_hours WHERE day < ?',
      ).bind(cutoffDay),
      env.DB.prepare(
        'INSERT INTO path_stats (path, visits, last_seen) VALUES (?, 1, ?) ' +
        'ON CONFLICT(path) DO UPDATE SET visits = visits + 1, last_seen = excluded.last_seen',
      ).bind(cleanPath, now),
      env.DB.prepare(
        'DELETE FROM path_stats WHERE last_seen < ?',
      ).bind(now - CONFIG.visitorRetentionMs),
    ]);
  } catch (e) {
    console.error('recordVisit failed:', e && e.message ? e.message : e);
  }
}

function scheduleVisit(env, ctx, request, path) {
  try {
    const p = recordVisit(env, request, path);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    else p.catch(() => {});
  } catch {
    // Never break the response on a logging failure.
  }
}

async function handleRedirect(request, env, alias) {
  const url = new URL(request.url);
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT id, destination, enabled, expires_at FROM links WHERE alias = ?',
  ).bind(alias).first();
  if (!row) return new Response('ბმული არ მოიძებნა.', { status: 404 });
  if (row.enabled !== 1) return new Response('ბმული გამორთულია.', { status: 410 });
  if (row.expires_at !== null && row.expires_at <= now) {
    return new Response('ბმულის ვადა გავიდა.', { status: 410 });
  }

  // Count the click atomically (single UPDATE). Bot visits redirect but are
  // not counted. If counting fails, still redirect — availability first.
  // For non-bot clicks, also record a click event (link_id + timestamp
  // ONLY — no IP, no User-Agent, nothing else) and prune each link to its
  // newest 100 events, so the table cannot grow forever.
  if (!isBot(request.headers.get('User-Agent'))) {
    try {
      await ensureV3Schema(env);
      await env.DB.batch([
        env.DB.prepare('UPDATE links SET clicks = clicks + 1 WHERE alias = ?').bind(alias),
        env.DB.prepare(
          'INSERT INTO click_events (link_id, clicked_at) VALUES (?, ?)',
        ).bind(row.id, now),
        env.DB.prepare(
          'DELETE FROM click_events WHERE link_id = ? AND id NOT IN (' +
          'SELECT id FROM click_events WHERE link_id = ? ' +
          'ORDER BY clicked_at DESC, id DESC LIMIT 100)',
        ).bind(row.id, row.id),
      ]);
    } catch (e) {
      console.error('click increment failed:', e && e.message ? e.message : e);
    }
  }
  return Response.redirect(row.destination, 302);
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function readJson(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return { ok: false, reason: 'Content-Type უნდა იყოს application/json.' };
  let body;
  try {
    body = await request.json();
  } catch {
    return { ok: false, reason: 'JSON სხეული არასწორია.' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'JSON სხეული ობიექტი უნდა იყოს.' };
  }
  return { ok: true, body };
}

// Mutating API calls from a browser must come from this site (SameSite=Lax
// already blocks cross-site cookies; this is a second layer).
function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser client (curl, etc.)
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* ---------------- Turnstile (bot check, public form only) ------------- */
// Cloudflare Turnstile, free tier. Verification runs ONLY when the
// TURNSTILE_SECRET_KEY secret is set in Cloudflare; without it the
// public form works exactly as before (no widget, no check). The site
// key is public and lives in index.html (window.MINILINK_TURNSTILE_SITEKEY).
// No IP is sent to Cloudflare for verification.
async function verifyTurnstile(env, token) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured — verification skipped
  if (!token) return false; // configured but the client sent no token
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'secret=' + encodeURIComponent(secret) + '&response=' + encodeURIComponent(token),
    });
    const data = await res.json().catch(() => null);
    return !!(data && data.success === true);
  } catch {
    // Verification service unreachable — availability first.
    console.error('Turnstile verification failed (network), allowing request');
    return true;
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // v2 schema (users, user_sessions, email_codes, links.user_id) is applied
  // lazily on first use — see ensureV2Schema. After the first successful
  // run this is a single cached check (no extra query on warm isolates).
  await ensureV2Schema(env);
  // v3 schema (click_events) — same lazy pattern, see ensureV3Schema.
  await ensureV3Schema(env);
  // v4 schema (links.note) — same lazy pattern, see ensureV4Schema.
  await ensureV4Schema(env);
  // v5 schema (qr_favorites) — same lazy pattern, see ensureV5Schema.
  await ensureV5Schema(env);
  // v6 schema (qr_history) — same lazy pattern, see ensureV6Schema.
  await ensureV6Schema(env);
  // v7.0 schema (chat_threads, chat_messages, chat_attachments) — same
  // lazy pattern, see ensureV7Schema.
  await ensureV7Schema(env);
  // v7.3 schema (chat_attachments.r2_key) — same lazy pattern, see
  // ensureV8Schema.
  await ensureV8Schema(env);
  // v8.0 schema (profiles, profile_links) — same lazy pattern, see
  // ensureV9Schema.
  await ensureV9Schema(env);
  // v10.0 schema (visitors) — same lazy pattern, see ensureV10Schema.
  await ensureV10Schema(env);
  // v10.1 schema (ip_exclusions) — same lazy pattern, see ensureV11Schema.
  await ensureV11Schema(env);
  // v10.2 schema (visitor_users) — same lazy pattern, see ensureV12Schema.
  await ensureV12Schema(env);
  // v10.3 schema (visitors enrichment + visit_hours/path_stats/screen_stats) — same lazy pattern, see ensureV13Schema.
  await ensureV13Schema(env);
  // v10.4 schema (visitors note + visit_events) — same lazy pattern, see ensureV14Schema.
  await ensureV14Schema(env);

  // --- v7: Telegram bot webhook (no session; secret-token auth) -------
  // Lives here, before the session check, because Telegram calls it —
  // authentication is the X-Telegram-Bot-Api-Secret-Token header, checked
  // inside handleTelegramWebhook. See the "Telegram bot (v7)" section.
  if (path === '/api/telegram/webhook') {
    if (method !== 'POST') return error('მეთოდი დაუშვებელია.', 405);
    return await handleTelegramWebhook(request, env);
  }

  // --- Public: login -------------------------------------------------
  if (path === '/api/login' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const hash = await ipHash(request, env);
    const allowed = await rateLimit(env, `login:${hash}`, CONFIG.loginMaxAttempts, CONFIG.loginWindowSec);
    if (!allowed) return error('ძალიან ბევრი მცდელობა. სცადეთ 10 წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const password = parsed.body.password;
    if (typeof password !== 'string' || !password) return error('პაროლი შეიყვანეთ.', 400);
    const ok = await verifyPassword(password, env.ADMIN_PASSWORD_HASH || '');
    if (!ok) return error('პაროლი არასწორია.', 401);
    const { token, expiresAt } = await createSession(env);
    const secure = new URL(request.url).protocol === 'https:';
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, expiresAt, secure) });
  }

  // --- Public: session status ----------------------------------------
  if (path === '/api/me' && method === 'GET') {
    const session = await getSession(env, request);
    return json({ authenticated: !!session });
  }

  // --- Public: shorten a link (no login) -------------------------------
  // Anyone can shorten a link from the public site. Stricter limits than
  // the admin API: 3/min + 10/hour per hashed IP. Auto-generated alias
  // only (no custom aliases, no expiry from the public form) — the admin
  // can edit or delete any link from the dashboard afterwards.
  if (path === '/api/public/shorten' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const minOk = await checkRateLimit(request, env, 'public-create', CONFIG.publicCreateMaxPerMin, 60);
    if (!minOk) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const hourOk = await checkRateLimit(request, env, 'public-create-hour', CONFIG.publicCreateMaxPerHour, 3600);
    if (!hourOk) return error('ლიმიტი ამოიწურა — კიდევ ბმულის შექმნა ერთ საათში შეგეძლებათ.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    // Turnstile (only when the secret is configured — see verifyTurnstile).
    const human = await verifyTurnstile(env, parsed.body.turnstileToken);
    if (!human) return error('დაადასტურეთ, რომ ადამიანი ხართ.', 400);
    const nv = validateNote(parsed.body.note);
    if (!nv.ok) return error(nv.reason, 400);
    const v = validateDestination(parsed.body.destination, ownHosts(request));
    if (!v.ok) return error(v.reason, 400);
    // v2: a logged-in user gets the link in their own space; logged-out
    // visitors keep creating anonymous links exactly as before.
    let ownerId = null;
    try {
      const userSession = await getUserSession(env, request);
      if (userSession) ownerId = userSession.userId;
    } catch { /* session lookup failure -> anonymous, as before */ }
    const alias = await insertAutoLink(env, v.url, null, ownerId, nv.note);
    if (!alias) return error('ბმულის შექმნა ვერ მოხერხდა — სცადეთ ხელახლა.', 500);
    const row = await env.DB.prepare(
      'SELECT id, alias, destination, created_at, expires_at, enabled, clicks, note FROM links WHERE alias = ?',
    ).bind(alias).first();
    return json({ link: linkRowToJson(request, row) }, 201);
  }

  // --- v2: user accounts (voluntary) ----------------------------------
  // All /api/auth/* routes are public (no admin session). They use their
  // own user session (cookie `user_session`, table `user_sessions`), so a
  // user login never interferes with the admin `session` cookie.

  if (path === '/api/auth/register' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const ipOk = await checkRateLimit(request, env, 'register-ip', CONFIG.registerMaxPerHourIp, 3600);
    if (!ipOk) return error('ძალიან ბევრი რეგისტრაცია. სცადეთ ერთ საათში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const uv = validateUsername(parsed.body.username);
    if (!uv.ok) return error(uv.reason, 400);
    const ev = validateEmail(parsed.body.email);
    if (!ev.ok) return error(ev.reason, 400);
    const pv = validateUserPassword(parsed.body.password);
    if (!pv.ok) return error(pv.reason, 400);
    const emailHash = await sha256Hex('register-email:' + ev.email);
    const emailOk = await rateLimit(env, `register-email:${emailHash}`, CONFIG.registerMaxPerHourEmail, 3600);
    if (!emailOk) return error('ამ მეილზე ძალიან ბევრი რეგისტრაცია. სცადეთ ერთ საათში.', 429);
    const existing = await env.DB.prepare(
      'SELECT username, email FROM users WHERE username = ? OR email = ?',
    ).bind(uv.username, ev.email).first();
    if (existing) {
      if (existing.username === uv.username) return error('მომხმარებლის სახელი დაკავებულია.', 409);
      return error('ამ მეილზე ანგარიში უკვე არსებობს.', 409);
    }
    const passwordHash = await hashPassword(parsed.body.password);
    const ins = await env.DB.prepare(
      'INSERT INTO users (username, email, password_hash, email_verified, disabled, created_at) ' +
      'VALUES (?, ?, ?, 0, 0, ?)',
    ).bind(uv.username, ev.email, passwordHash, Date.now()).run();
    if (!ins.success) return error('რეგისტრაცია ვერ მოხერხდა — სცადეთ ხელახლა.', 500);
    const userId = ins.meta.last_row_id;
    const code = await issueEmailCode(env, userId, ev.email, 'verify');
    const sent = await sendEmailCode(env, ev.email, code, 'verify');
    const user = await env.DB.prepare(
      'SELECT id, username, email, email_verified, disabled, created_at FROM users WHERE id = ?',
    ).bind(userId).first();
    const out = { user: userToJson(user), emailSent: sent.ok };
    if (!sent.ok) out.error = sent.error; // 'email_not_configured' | 'email_send_failed'
    return json(out, 201);
  }

  if (path === '/api/auth/verify-email' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const rateOk = await checkRateLimit(request, env, 'verify', 10, 60);
    if (!rateOk) return error('ძალიან ბევრი მცდელობა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const ev = validateEmail(parsed.body.email);
    if (!ev.ok) return error(ev.reason, 400);
    const code = String(parsed.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return error('კოდი 6 ციფრისგან უნდა შედგებოდეს.', 400);
    const user = await env.DB.prepare(
      'SELECT id, username, email, email_verified, disabled, created_at FROM users WHERE email = ?',
    ).bind(ev.email).first();
    if (!user) return error('კოდი არასწორია ან ვადა გავიდა.', 400);
    if (user.disabled === 1) return error('ანგარიში გათიშულია.', 403);
    const secure = new URL(request.url).protocol === 'https:';
    if (user.email_verified === 1) {
      // Already verified (e.g. double submit): just log them in.
      const sess = await createUserSession(env, user.id);
      return json({ ok: true, alreadyVerified: true, user: userToJson(user) }, 200, {
        'Set-Cookie': userSessionCookie(sess.token, sess.expiresAt, secure),
      });
    }
    const check = await verifyEmailCode(env, user.id, 'verify', code);
    if (!check.ok) return error(check.reason, 400);
    await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(user.id).run();
    const sess = await createUserSession(env, user.id);
    const fresh = await env.DB.prepare(
      'SELECT id, username, email, email_verified, disabled, created_at FROM users WHERE id = ?',
    ).bind(user.id).first();
    return json({ ok: true, user: userToJson(fresh) }, 200, {
      'Set-Cookie': userSessionCookie(sess.token, sess.expiresAt, secure),
    });
  }

  if (path === '/api/auth/resend-code' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const ev = validateEmail(parsed.body.email);
    if (!ev.ok) return error(ev.reason, 400);
    const purpose = parsed.body.purpose === 'reset' ? 'reset' : 'verify';
    const emailHash = await sha256Hex('resend:' + ev.email);
    const minOk = await rateLimit(env, `resend-min:${emailHash}`, CONFIG.resendCodeMaxPerMin, 60);
    if (!minOk) return error('კოდი ახლახან გაიგზავნა — სცადეთ ერთ წუთში.', 429);
    const hourOk = await rateLimit(env, `resend-hour:${emailHash}`, CONFIG.resendCodeMaxPerHour, 3600);
    if (!hourOk) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ საათში.', 429);
    const user = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(ev.email).first();
    if (!user) return json({ ok: true }); // do not leak whether the email exists
    if (purpose === 'verify' && user.email_verified === 1) return json({ ok: true, alreadyVerified: true });
    const code = await issueEmailCode(env, user.id, ev.email, purpose);
    const sent = await sendEmailCode(env, ev.email, code, purpose);
    if (!sent.ok) return json({ ok: false, error: sent.error });
    return json({ ok: true });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const loginRaw = parsed.body.login ?? parsed.body.username ?? parsed.body.email;
    if (typeof loginRaw !== 'string' || !loginRaw.trim()) {
      return error('მომხმარებლის სახელი ან მეილი შეიყვანეთ.', 400);
    }
    const login = loginRaw.trim();
    const password = parsed.body.password;
    if (typeof password !== 'string' || !password) return error('პაროლი შეიყვანეთ.', 400);
    const ipH = await ipHash(request, env);
    const loginKey = await sha256Hex(login.toLowerCase() + '|' + ipH);
    const allowed = await rateLimit(env, `user-login:${loginKey}`, CONFIG.userLoginMaxAttempts, CONFIG.userLoginWindowSec);
    if (!allowed) return error('ძალიან ბევრი მცდელობა. სცადეთ 10 წუთში.', 429);
    const user = await env.DB.prepare(
      'SELECT id, username, email, password_hash, email_verified, disabled, created_at ' +
      'FROM users WHERE username = ? OR email = ?',
    ).bind(login, login.toLowerCase()).first();
    if (!user) return error('მომხმარებლის სახელი/მეილი ან პაროლი არასწორია.', 401);
    if (user.disabled === 1) return error('ანგარიში გათიშულია.', 403);
    const okPass = await verifyPassword(password, user.password_hash);
    if (!okPass) return error('მომხმარებლის სახელი/მეილი ან პაროლი არასწორია.', 401);
    if (user.email_verified !== 1) {
      return json({ error: 'email_not_verified', email: user.email }, 403);
    }
    const sess = await createUserSession(env, user.id);
    const secure = new URL(request.url).protocol === 'https:';
    return json({ ok: true, user: userToJson(user) }, 200, {
      'Set-Cookie': userSessionCookie(sess.token, sess.expiresAt, secure),
    });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    await destroyUserSession(env, request);
    const secure = new URL(request.url).protocol === 'https:';
    return json({ ok: true }, 200, {
      'Set-Cookie': `user_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`,
    });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const user = await env.DB.prepare(
      'SELECT id, username, email, email_verified, disabled, created_at FROM users WHERE id = ?',
    ).bind(userSession.userId).first();
    if (!user) return error('შესვლა საჭიროა.', 401);
    return json({ user: userToJson(user) });
  }

  if (path === '/api/auth/forgot-password' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const ev = validateEmail(parsed.body.email);
    if (!ev.ok) return error(ev.reason, 400);
    const emailHash = await sha256Hex('forgot:' + ev.email);
    const emailOk = await rateLimit(env, `forgot-email:${emailHash}`, CONFIG.forgotMaxPerHourEmail, 3600);
    const ipOk = await checkRateLimit(request, env, 'forgot-ip', CONFIG.forgotMaxPerHourIp, 3600);
    if (!emailOk || !ipOk) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ საათში.', 429);
    const user = await env.DB.prepare('SELECT id, disabled FROM users WHERE email = ?').bind(ev.email).first();
    // Always respond success — never reveal whether the email exists.
    if (user && user.disabled !== 1) {
      const code = await issueEmailCode(env, user.id, ev.email, 'reset');
      await sendEmailCode(env, ev.email, code, 'reset');
    }
    return json({ ok: true });
  }

  if (path === '/api/auth/reset-password' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const rateOk = await checkRateLimit(request, env, 'reset', 10, 60);
    if (!rateOk) return error('ძალიან ბევრი მცდელობა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const ev = validateEmail(parsed.body.email);
    if (!ev.ok) return error(ev.reason, 400);
    const code = String(parsed.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return error('კოდი 6 ციფრისგან უნდა შედგებოდეს.', 400);
    const pv = validateUserPassword(parsed.body.new_password);
    if (!pv.ok) return error(pv.reason, 400);
    const user = await env.DB.prepare('SELECT id, disabled FROM users WHERE email = ?').bind(ev.email).first();
    if (!user) return error('კოდი არასწორია ან ვადა გავიდა.', 400);
    if (user.disabled === 1) return error('ანგარიში გათიშულია.', 403);
    const check = await verifyEmailCode(env, user.id, 'reset', code);
    if (!check.ok) return error(check.reason, 400);
    const passwordHash = await hashPassword(parsed.body.new_password);
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?',
    ).bind(passwordHash, user.id).run();
    // All sessions are invalidated by a password reset; a fresh one is
    // created so the user stays logged in on this device.
    await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(user.id).run();
    const sess = await createUserSession(env, user.id);
    const secure = new URL(request.url).protocol === 'https:';
    const fresh = await env.DB.prepare(
      'SELECT id, username, email, email_verified, disabled, created_at FROM users WHERE id = ?',
    ).bind(user.id).first();
    return json({ ok: true, user: userToJson(fresh) }, 200, {
      'Set-Cookie': userSessionCookie(sess.token, sess.expiresAt, secure),
    });
  }

  // --- v2: a user's own links (their space) ---------------------------
  if (path === '/api/auth/links' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const rows = await env.DB.prepare(
      'SELECT id, alias, destination, created_at, expires_at, enabled, clicks, note ' +
      'FROM links WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).bind(userSession.userId, CONFIG.maxLinksList).all();
    return json({ links: (rows.results || []).map((r) => linkRowToJson(request, r)) });
  }

  // --- v3: a user's own recent clicks (their links only) --------------
  if (path === '/api/auth/clicks/recent' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const rows = await env.DB.prepare(
      'SELECT c.clicked_at, l.alias, l.destination, l.note ' +
      'FROM click_events c JOIN links l ON l.id = c.link_id ' +
      'WHERE l.user_id = ? ORDER BY c.clicked_at DESC, c.id DESC LIMIT 20',
    ).bind(userSession.userId).all();
    return json({
      clicks: (rows.results || []).map((r) => ({
        clickedAt: r.clicked_at,
        alias: r.alias,
        shortUrl: publicLink(request, r.alias),
        destination: r.destination,
        note: r.note !== undefined && r.note !== null ? r.note : '',
      })),
    });
  }

  // --- v5: QR Maker favorites (logged-in users only) ------------------
  // Anonymous users keep favorites in localStorage on their own device.
  function validateQrFavorite(body) {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'მონაცემები არასწორია.' };
    const types = ['link', 'instagram', 'wifi', 'phone', 'text', 'review'];
    if (!types.includes(body.type)) return { ok: false, reason: 'QR ტიპი არასწორია.' };
    if (typeof body.label !== 'string' || !body.label.trim()) return { ok: false, reason: 'სახელი შეიყვანეთ.' };
    const label = body.label.trim();
    if (label.length > 100) return { ok: false, reason: 'სახელი მაქს. 100 სიმბოლოა.' };
    if (typeof body.payload !== 'string' || !body.payload.trim()) return { ok: false, reason: 'QR შიგთავსი ცარიელია.' };
    const payload = body.payload.trim();
    if (payload.length > 2048) return { ok: false, reason: 'QR შიგთავსი ძალიან გრძელია (მაქს. 2048 სიმბოლო).' };
    const colorRe = /^#[0-9a-fA-F]{6}$/;
    const fg = typeof body.fg === 'string' && colorRe.test(body.fg) ? body.fg : '#000000';
    const bg = typeof body.bg === 'string' && colorRe.test(body.bg) ? body.bg : '#ffffff';
    return { ok: true, fav: { type: body.type, label, payload, fg, bg } };
  }

  if (path === '/api/auth/qr-favorites' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const rows = await env.DB.prepare(
      'SELECT id, type, label, payload, fg, bg, created_at FROM qr_favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    ).bind(userSession.userId).all();
    return json({ favorites: rows.results || [] });
  }

  if (path === '/api/auth/qr-favorites' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const allowed = await checkRateLimit(request, env, 'qr-fav-create', 20, 3600);
    if (!allowed) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ საათში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const v = validateQrFavorite(parsed.body);
    if (!v.ok) return error(v.reason, 400);
    const now = Date.now();
    const res = await env.DB.prepare(
      'INSERT INTO qr_favorites (user_id, type, label, payload, fg, bg, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(userSession.userId, v.fav.type, v.fav.label, v.fav.payload, v.fav.fg, v.fav.bg, now).run();
    if (!res.success) return error('შენახვა ვერ მოხერხდა.', 500);
    // v6: mark the matching generation as a favorite in the history log.
    // If the generation has not been logged yet (slow network), record it
    // here so the admin still sees it.
    try {
      const marked = await env.DB.prepare(
        'UPDATE qr_history SET favorite = 1 WHERE id = ' +
        '(SELECT id FROM qr_history WHERE user_id = ? AND payload = ? ORDER BY created_at DESC LIMIT 1)',
      ).bind(userSession.userId, v.fav.payload).run();
      if (!marked.meta || marked.meta.changes === 0) {
        await env.DB.prepare(
          'INSERT INTO qr_history (user_id, type, label, payload, fg, bg, favorite, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        ).bind(userSession.userId, v.fav.type, v.fav.label, v.fav.payload, v.fav.fg, v.fav.bg, now).run();
      }
    } catch { /* history flag is best-effort */ }
    return json({ ok: true, favorite: { id: res.meta.last_row_id, ...v.fav, created_at: now } }, 201);
  }

  const qrFavMatch = path.match(/^\/api\/auth\/qr-favorites\/(\d+)$/);
  if (qrFavMatch) {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (method !== 'DELETE') return error('მეთოდი დაუშვებელია.', 405);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const id = parseInt(qrFavMatch[1], 10);
    const own = await env.DB.prepare('SELECT user_id, payload FROM qr_favorites WHERE id = ?').bind(id).first();
    if (!own) return error('რჩეული არ მოიძებნა.', 404);
    if (own.user_id !== userSession.userId) return error('ეს რჩეული თქვენ არ გეკუთვნით.', 403);
    const res = await env.DB.prepare('DELETE FROM qr_favorites WHERE id = ?').bind(id).run();
    if (!res.success || (res.meta && res.meta.changes === 0)) return error('რჩეული არ მოიძებნა.', 404);
    // v6: the generation stays in the history log, but is no longer a favorite.
    try {
      await env.DB.prepare(
        'UPDATE qr_history SET favorite = 0 WHERE user_id = ? AND payload = ?',
      ).bind(userSession.userId, own.payload).run();
    } catch { /* history flag is best-effort */ }
    return json({ ok: true });
  }

  // --- v6: log every generated QR (public, fire-and-forget) ------------
  // The QR Maker renders on-device, but each generation is also logged
  // server-side so the admin sees EVERYTHING (like links): logged-in
  // users get their user_id attached, anonymous rows stay ownerless.
  // The client ignores failures — the QR still renders. Privacy note:
  // unlike v5, the generated QR content IS sent to the server now; no IP
  // is stored (rate limiting uses only the daily IP hash).
  // --- v10.4: behavior events (public ingest, admin-only viewing) ------
  // Sent by public.js: page opens, clicks (labels only, never input
  // values), time on page + max scroll depth. One random session id per
  // page load — no cookies, no storage, no cross-visit identity.
  // Excluded IPs and bots are silently dropped.
  if (path === '/api/visit-events' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const ip = request.headers.get('CF-Connecting-IP');
    if (isBot(request.headers.get('User-Agent')) || !ip || ip === 'unknown' || ip.length > 45) {
      return json({ ok: true });
    }
    const excluded = await env.DB.prepare(
      'SELECT 1 AS x FROM ip_exclusions WHERE ip = ?',
    ).bind(ip).first();
    if (excluded) return json({ ok: true });
    const allowedMin = await checkRateLimit(request, env, 'visit-events', CONFIG.eventMaxPerMin, 60);
    const allowedHour = allowedMin && await checkRateLimit(request, env, 'visit-events-hour', CONFIG.eventMaxPerHour, 3600);
    if (!allowedHour) return error('ძალიან ბევრი მოთხოვნა. სცადეთ მოგვიანებით.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const b = parsed.body;
    if (typeof b.session !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(b.session)) return error('არასწორი სესია.', 400);
    if (b.type !== 'pageview' && b.type !== 'click' && b.type !== 'time') return error('არასწორი მოვლენის ტიპი.', 400);
    const cleanPath = typeof b.path === 'string' ? b.path.slice(0, 200) : null;
    let label = null;
    if (b.type === 'click') {
      if (typeof b.label !== 'string') return error('არასწორი ეტიკეტი.', 400);
      label = b.label.trim().slice(0, 100);
      if (!label) return error('არასწორი ეტიკეტი.', 400);
    }
    let seconds = null;
    let scroll = null;
    if (b.type === 'time') {
      if (!Number.isInteger(b.seconds) || b.seconds < 0 || b.seconds > 86400) return error('არასწორი დრო.', 400);
      seconds = b.seconds;
      if (b.scroll !== undefined && b.scroll !== null) {
        if (!Number.isInteger(b.scroll) || b.scroll < 0 || b.scroll > 100) return error('არასწორი სქროლი.', 400);
        scroll = b.scroll;
      }
    }
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO visit_events (ip, session, type, path, label, seconds, scroll, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(ip, b.session, b.type, cleanPath, label, seconds, scroll, now).run();
    await env.DB.prepare(
      'DELETE FROM visit_events WHERE created_at < ?',
    ).bind(now - CONFIG.visitorRetentionMs).run();
    await env.DB.prepare(
      'DELETE FROM visit_events WHERE id NOT IN (SELECT id FROM visit_events ORDER BY id DESC LIMIT ?)',
    ).bind(CONFIG.maxVisitEvents).run();
    return json({ ok: true });
  }

  // --- v10.3: screen-size beacon (public, aggregate only) --------------
  // Fired once per main-page load from public.js. Stores ONLY the
  // resolution histogram — no IP, no identifier of any kind.
  if (path === '/api/visit-beacon' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const allowedMin = await checkRateLimit(request, env, 'beacon', CONFIG.beaconMaxPerMin, 60);
    const allowedHour = allowedMin && await checkRateLimit(request, env, 'beacon-hour', CONFIG.beaconMaxPerHour, 3600);
    if (!allowedHour) return error('ძალიან ბევრი მოთხოვნა. სცადეთ მოგვიანებით.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const w = parsed.body.w;
    const h = parsed.body.h;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 100 || w > 10000 || h < 100 || h > 10000) {
      return error('არასწორი ეკრანის ზომა.', 400);
    }
    await env.DB.prepare(
      'INSERT INTO screen_stats (resolution, visits) VALUES (?, 1) ' +
      'ON CONFLICT(resolution) DO UPDATE SET visits = visits + 1',
    ).bind(w + 'x' + h).run();
    return json({ ok: true });
  }
  if (path === '/api/qr-log' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const allowedMin = await checkRateLimit(request, env, 'qr-log', 20, 60);
    const allowedHour = allowedMin && await checkRateLimit(request, env, 'qr-log-hour', 200, 3600);
    if (!allowedHour) return error('ძალიან ბევრი მოთხოვნა. სცადეთ მოგვიანებით.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const v = validateQrFavorite(parsed.body);
    if (!v.ok) return error(v.reason, 400);
    const userSession = await getUserSession(env, request);
    const now = Date.now();
    const res = await env.DB.prepare(
      'INSERT INTO qr_history (user_id, type, label, payload, fg, bg, favorite, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
    ).bind(userSession ? userSession.userId : null, v.fav.type, v.fav.label, v.fav.payload, v.fav.fg, v.fav.bg, now).run();
    if (!res.success) return error('ჩაწერა ვერ მოხერხდა.', 500);
    // Prune old non-favorite rows so the log cannot grow forever
    // (newest ~2000 generations are kept; favorites are never pruned).
    try {
      await env.DB.prepare(
        'DELETE FROM qr_history WHERE favorite = 0 AND created_at < ' +
        '(SELECT created_at FROM qr_history ORDER BY created_at DESC LIMIT 1 OFFSET 1999)',
      ).run();
    } catch { /* prune is best-effort */ }
    return json({ ok: true, id: res.meta.last_row_id }, 201);
  }

  // --- v3: click history of one of the user's own links ---------------
  const authLinkClicksMatch = path.match(/^\/api\/auth\/links\/(\d+)\/clicks$/);
  if (authLinkClicksMatch) {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const id = parseInt(authLinkClicksMatch[1], 10);
    const own = await env.DB.prepare('SELECT user_id FROM links WHERE id = ?').bind(id).first();
    if (!own) return error('ბმული არ მოიძებნა.', 404);
    if (own.user_id !== userSession.userId) return error('ეს ბმული თქვენ არ გეკუთვნით.', 403);
    if (method !== 'GET') return error('მეთოდი დაუშვებელია.', 405);
    const rows = await env.DB.prepare(
      'SELECT clicked_at FROM click_events WHERE link_id = ? ' +
      'ORDER BY clicked_at DESC, id DESC LIMIT 50',
    ).bind(id).all();
    return json({ events: (rows.results || []).map((r) => ({ clickedAt: r.clicked_at })) });
  }

  const authLinkMatch = path.match(/^\/api\/auth\/links\/(\d+)$/);
  if (authLinkMatch) {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const id = parseInt(authLinkMatch[1], 10);
    const own = await env.DB.prepare('SELECT user_id FROM links WHERE id = ?').bind(id).first();
    if (!own) return error('ბმული არ მოიძებნა.', 404);
    if (own.user_id !== userSession.userId) return error('ეს ბმული თქვენ არ გეკუთვნით.', 403);
    if (method === 'PATCH') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      const parsed = await readJson(request);
      if (!parsed.ok) return error(parsed.reason, 400);
      const updates = [];
      const values = [];
      if (typeof parsed.body.enabled === 'boolean') {
        updates.push('enabled = ?');
        values.push(parsed.body.enabled ? 1 : 0);
      }
      if ('expiresAt' in parsed.body) {
        const e = parsed.body.expiresAt;
        if (e === null || e === '') {
          updates.push('expires_at = NULL');
        } else {
          const n = typeof e === 'number' ? e : Date.parse(e);
          if (!Number.isFinite(n)) return error('ვადის თარიღი არასწორია.', 400);
          if (n <= Date.now()) return error('ვადა მომავალში უნდა იყოს.', 400);
          updates.push('expires_at = ?');
          values.push(n);
        }
      }
      if ('note' in parsed.body) {
        const nv = validateNote(parsed.body.note);
        if (!nv.ok) return error(nv.reason, 400);
        if (nv.note === null) updates.push('note = NULL');
        else { updates.push('note = ?'); values.push(nv.note); }
      }
      if (updates.length === 0) return error('შესაცვლელი არაფერია.', 400);
      values.push(id);
      const res = await env.DB.prepare(
        `UPDATE links SET ${updates.join(', ')} WHERE id = ?`,
      ).bind(...values).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('ბმული არ მოიძებნა.', 404);
      }
      const row = await env.DB.prepare(
        'SELECT id, alias, destination, created_at, expires_at, enabled, clicks, note FROM links WHERE id = ?',
      ).bind(id).first();
      return json({ link: linkRowToJson(request, row) });
    }
    if (method === 'DELETE') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      // v8.0: drop profile buttons that pointed at the link FIRST —
      // deleting the link row first would violate the profile_links
      // foreign key where FK enforcement is on. Best-effort: the
      // profiles table may not exist yet.
      try {
        await env.DB.prepare('DELETE FROM profile_links WHERE link_id = ?').bind(id).run();
      } catch { /* ignore */ }
      const res = await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('ბმული არ მოიძებნა.', 404);
      }
      return json({ ok: true });
    }
    return error('მეთოდი დაუშვებელია.', 405);
  }

  // --- v7.0: admin chat — user side ------------------------------------
  // Visible ONLY to email-verified users. The gate is enforced here,
  // server-side, on every route — hiding the UI is not the protection.
  // Users send TEXT only; files come from the admin side. One thread
  // per user; the user always talks to the admin.

  // Download an attachment — admin session OR the owning user session.
  // A user may download only attachments from their own thread; the
  // admin may download any. Content-Type comes from the allowlist and
  // nosniff is set, so a stored file can never run as a page. Since
  // v7.3, bytes come from the private R2 bucket (r2_key); rows from
  // v7.0/v7.1 without r2_key fall back to the legacy D1 `data` blob.
  if (path === '/api/chat/attachment') {
    if (method !== 'GET') return error('მეთოდი დაუშვებელია.', 405);
    const id = parseInt(url.searchParams.get('id') || '', 10);
    if (!Number.isFinite(id) || id <= 0) return error('დანართი არ მოიძებნა.', 404);
    const adminSession = await getSession(env, request);
    let row = null;
    if (adminSession) {
      row = await env.DB.prepare(
        'SELECT file_name, mime_type, size_bytes, data, r2_key FROM chat_attachments WHERE id = ?',
      ).bind(id).first();
    } else {
      const userSession = await getUserSession(env, request);
      if (!userSession) return error('შესვლა საჭიროა.', 401);
      if (!userSession.emailVerified) return error('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებს აქვთ.', 403);
      row = await env.DB.prepare(
        'SELECT a.file_name, a.mime_type, a.size_bytes, a.data, a.r2_key ' +
        'FROM chat_attachments a JOIN chat_messages m ON m.id = a.message_id ' +
        'JOIN chat_threads t ON t.id = m.thread_id ' +
        'WHERE a.id = ? AND t.user_id = ?',
      ).bind(id, userSession.userId).first();
    }
    if (!row) return error('დანართი არ მოიძებნა.', 404);
    const isImage = String(row.mime_type).startsWith('image/');
    const asciiName = String(row.file_name).replace(/[^\x20-\x7E]/g, '_') || 'file';
    const headers = {
      'Content-Type': row.mime_type,
      'Content-Length': String(row.size_bytes),
      'Content-Disposition': (isImage ? 'inline' : 'attachment') +
        '; filename="' + asciiName.replace(/"/g, '_') + '"' +
        "; filename*=UTF-8''" + encodeURIComponent(row.file_name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    };
    if (row.r2_key) {
      if (!env.CHAT_FILES) return error('ფაილების საცავი მიუწვდომელია.', 500);
      const obj = await env.CHAT_FILES.get(row.r2_key);
      if (!obj) return error('დანართი არ მოიძებნა.', 404);
      return new Response(await obj.arrayBuffer(), { headers });
    }
    // Legacy row (v7.0/v7.1): serve the stored D1 blob as before.
    const bytes = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : row.data;
    return new Response(bytes, { headers });
  }

  // The user's own thread + messages. `?after=<id>` (polling) returns
  // only messages newer than that id. No thread yet -> empty result.
  if (path === '/api/chat/thread' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებს აქვთ.', 403);
    const thread = await env.DB.prepare(
      'SELECT id, user_id, created_at, last_message_at, admin_unread, user_unread FROM chat_threads WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!thread) return json({ thread: null, messages: [] });
    const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
    const messages = await listChatMessages(env, thread.id, after);
    return json({
      thread: { id: thread.id, userUnread: thread.user_unread, lastMessageAt: thread.last_message_at },
      messages,
    });
  }

  // Unread counter for the user's chat badge (lightweight poll).
  if (path === '/api/chat/unread' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებს აქვთ.', 403);
    const thread = await env.DB.prepare(
      'SELECT user_unread FROM chat_threads WHERE user_id = ?',
    ).bind(userSession.userId).first();
    return json({ unread: thread ? thread.user_unread : 0 });
  }

  // Send a text message (creates the thread on first use). Attachments
  // are rejected here — only the admin may send files.
  if (path === '/api/chat/send' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებს აქვთ.', 403);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const minOk = await rateLimit(env, `chat-user:${userSession.userId}`, CONFIG.chatUserMaxPerMin, 60);
    if (!minOk) return error('ძალიან ბევრი შეტყობინება. სცადეთ ერთ წუთში.', 429);
    const hourOk = await rateLimit(env, `chat-user-hour:${userSession.userId}`, CONFIG.chatUserMaxPerHour, 3600);
    if (!hourOk) return error('ლიმიტი ამოიწურა — შეტყობინების გაგზავნა ერთ საათში შეგეძლებათ.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    if (parsed.body.attachment !== undefined && parsed.body.attachment !== null) {
      return error('ფაილის გაგზავნა მხოლოდ ადმინს შეუძლია.', 400);
    }
    const body = typeof parsed.body.body === 'string' ? parsed.body.body.trim() : '';
    if (!body) return error('შეტყობინება ცარიელია.', 400);
    if (body.length > CONFIG.chatMaxBodyChars) {
      return error(`შეტყობინება მაქს. ${CONFIG.chatMaxBodyChars} სიმბოლო შეიძლება იყოს.`, 400);
    }
    const thread = await getOrCreateChatThread(env, userSession.userId);
    if (!thread) return error('ჩატის შექმნა ვერ მოხერხდა.', 500);
    const message = await insertChatMessage(env, thread, 'user', body, null);
    return json({ message }, 201);
  }

  // Mark the user's own thread as read (clears their unread counter).
  if (path === '/api/chat/read' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებს აქვთ.', 403);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    await env.DB.prepare('UPDATE chat_threads SET user_unread = 0 WHERE user_id = ?').bind(userSession.userId).run();
    return json({ ok: true });
  }

  // --- v8.0: profile pages — user side ---------------------------------
  // Creation is EXPLICIT and gated on email verification (same
  // server-side gate as the chat). The public page (/@username) is
  // rendered by handleProfilePage, outside handleApi.

  // Per-user write rate limit shared by all profile mutations.
  async function profileWriteAllowed(userId) {
    return rateLimit(env, `profile-write:${userId}`, CONFIG.profileWriteMaxPerMin, 60);
  }

  // Create the caller's profile with defaults (display name = username,
  // empty bio, view counter ON, link limit 5). 409 when one exists.
  if (path === '/api/profile' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('პროფილის შექმნა მხოლოდ მეილზე დადასტურებულ მომხმარებლებს შეუძლიათ.', 403);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const existing = await env.DB.prepare(
      'SELECT user_id FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (existing) return error('პროფილი უკვე შექმნილია.', 409);
    const now = new Date().toISOString();
    const ins = await env.DB.prepare(
      'INSERT INTO profiles (user_id, display_name, bio, show_views, link_limit, view_count, created_at, updated_at) ' +
      'VALUES (?, ?, ?, 1, ?, 0, ?, ?)',
    ).bind(userSession.userId, userSession.username, '', CONFIG.profileDefaultLinkLimit, now, now).run();
    if (!ins.success) return error('პროფილის შექმნა ვერ მოხერხდა.', 500);
    const row = await env.DB.prepare(
      'SELECT display_name, bio, avatar_r2_key, show_views, link_limit, view_count FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    return json({ profile: profileToJson(request, userSession.username, row, []) }, 201);
  }

  // The caller's own profile + buttons (ordered) + counts + limit.
  // No profile yet -> { profile: null }. Any logged-in user may call
  // this (the editor needs to know whether a profile exists); the
  // verified gate applies to creation and mutations, not to reading.
  if (path === '/api/profile/me' && method === 'GET') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const row = await env.DB.prepare(
      'SELECT display_name, bio, avatar_r2_key, show_views, link_limit, view_count FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!row) return json({ profile: null });
    const linkRows = await listProfileLinks(env, userSession.userId);
    return json({ profile: profileToJson(request, userSession.username, row, linkRows) });
  }

  // Update display name / bio / view-counter visibility.
  if (path === '/api/profile' && method === 'PATCH') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const existing = await env.DB.prepare(
      'SELECT display_name, bio, avatar_r2_key, show_views, link_limit, view_count FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!existing) return error('პროფილი არ მოიძებნა.', 404);
    const updates = [];
    const values = [];
    if ('display_name' in parsed.body) {
      const dv = validateProfileText(parsed.body.display_name, CONFIG.profileMaxDisplayName, 'სახელი', false);
      if (!dv.ok) return error(dv.reason, 400);
      updates.push('display_name = ?');
      values.push(dv.value);
    }
    if ('bio' in parsed.body) {
      const bv = validateProfileText(parsed.body.bio, CONFIG.profileMaxBio, 'ბიო', true);
      if (!bv.ok) return error(bv.reason, 400);
      updates.push('bio = ?');
      values.push(bv.value);
    }
    if ('show_views' in parsed.body) {
      if (typeof parsed.body.show_views !== 'boolean') {
        return error('ველის "show_views" მნიშვნელობა true ან false უნდა იყოს.', 400);
      }
      updates.push('show_views = ?');
      values.push(parsed.body.show_views ? 1 : 0);
    }
    if (updates.length === 0) return error('შესაცვლელი არაფერია.', 400);
    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(userSession.userId);
    await env.DB.prepare(
      `UPDATE profiles SET ${updates.join(', ')} WHERE user_id = ?`,
    ).bind(...values).run();
    const row = await env.DB.prepare(
      'SELECT display_name, bio, avatar_r2_key, show_views, link_limit, view_count FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    const linkRows = await listProfileLinks(env, userSession.userId);
    return json({ profile: profileToJson(request, userSession.username, row, linkRows) });
  }

  // Upload/replace the avatar. Bytes go to the private R2 bucket
  // (avatars/<uuid>); the old object is deleted after a successful
  // replace. The new object is uploaded FIRST so a failed put never
  // leaves the profile pointing at missing bytes.
  if (path === '/api/profile/avatar' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('პროფილის მართვა მხოლოდ მეილზე დადასტურებულ მომხმარებლებს შეუძლიათ.', 403);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const existing = await env.DB.prepare(
      'SELECT avatar_r2_key FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!existing) return error('პროფილი არ მოიძებნა.', 404);
    const raw = parsed.body.avatar !== undefined ? parsed.body.avatar : parsed.body;
    const av = validateProfileAvatar(raw);
    if (!av.ok) return error(av.reason, 400);
    if (!env.CHAT_FILES) {
      return error('ფაილების საცავი (R2) არ არის დაკავშირებული — ავატარის ატვირთვა შეუძლებელია.', 500);
    }
    const r2Key = 'avatars/' + crypto.randomUUID();
    await env.CHAT_FILES.put(r2Key, av.avatar.bytes, {
      httpMetadata: { contentType: av.avatar.mimeType },
    });
    try {
      await env.DB.prepare(
        'UPDATE profiles SET avatar_r2_key = ?, avatar_mime = ?, updated_at = ? WHERE user_id = ?',
      ).bind(r2Key, av.avatar.mimeType, new Date().toISOString(), userSession.userId).run();
    } catch (e) {
      // Don't orphan the new R2 object if the row update fails.
      try { await env.CHAT_FILES.delete(r2Key); } catch { /* best-effort */ }
      throw e;
    }
    if (existing.avatar_r2_key) {
      try { await env.CHAT_FILES.delete(existing.avatar_r2_key); } catch { /* best-effort, ignore missing */ }
    }
    return json({ ok: true, avatarUrl: '/@' + userSession.username + '/avatar' });
  }

  // Remove the avatar (fields cleared + R2 object deleted, best-effort).
  // Idempotent: no avatar -> success, nothing to do.
  if (path === '/api/profile/avatar' && method === 'DELETE') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const existing = await env.DB.prepare(
      'SELECT avatar_r2_key FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!existing) return error('პროფილი არ მოიძებნა.', 404);
    const oldKey = existing.avatar_r2_key;
    await env.DB.prepare(
      'UPDATE profiles SET avatar_r2_key = NULL, avatar_mime = NULL, updated_at = ? WHERE user_id = ?',
    ).bind(new Date().toISOString(), userSession.userId).run();
    if (oldKey && env.CHAT_FILES) {
      try { await env.CHAT_FILES.delete(oldKey); } catch { /* best-effort, ignore missing */ }
    }
    return json({ ok: true });
  }

  // Add a button to the profile. kind 'short' picks one of the user's
  // own links (ownership enforced); kind 'manual' stores a hand-typed
  // https URL. The per-user limit is enforced here (409 limit_reached);
  // the client shows the "write to the admin" popup on that code.
  if (path === '/api/profile/links' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!userSession.emailVerified) return error('პროფილის მართვა მხოლოდ მეილზე დადასტურებულ მომხმარებლებს შეუძლიათ.', 403);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const profile = await env.DB.prepare(
      'SELECT link_limit FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!profile) return error('პროფილი არ მოიძებნა.', 404);
    const kind = parsed.body.kind;
    if (kind !== 'short' && kind !== 'manual') return error('ბმულის ტიპი არასწორია.', 400);
    const tv = validateProfileText(parsed.body.title, CONFIG.profileMaxTitle, 'სათაური', false);
    if (!tv.ok) return error(tv.reason, 400);
    let linkId = null;
    let url = '';
    if (kind === 'short') {
      const id = parseInt(parsed.body.link_id, 10);
      if (!Number.isFinite(id) || id <= 0) return error('ბმული არასწორია.', 400);
      const own = await env.DB.prepare('SELECT user_id FROM links WHERE id = ?').bind(id).first();
      if (!own) return error('ბმული არ მოიძებნა.', 404);
      if (own.user_id !== userSession.userId) return error('ეს ბმული თქვენ არ გეკუთვნით.', 403);
      linkId = id;
    } else {
      const uv = validateProfileManualUrl(parsed.body.url);
      if (!uv.ok) return error(uv.reason, 400);
      url = uv.url;
    }
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM profile_links WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if ((countRow ? countRow.n : 0) >= profile.link_limit) {
      return json({ error: 'limit_reached', message: 'ბმულების ლიმიტი ამოიწურა — მეტისთვის ადმინს მიწერეთ.' }, 409);
    }
    const posRow = await env.DB.prepare(
      'SELECT COALESCE(MAX(position), -1) AS m FROM profile_links WHERE user_id = ?',
    ).bind(userSession.userId).first();
    const position = (posRow ? posRow.m : -1) + 1;
    const ins = await env.DB.prepare(
      'INSERT INTO profile_links (user_id, position, kind, link_id, title, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(userSession.userId, position, kind, linkId, tv.value, url, new Date().toISOString()).run();
    if (!ins.success) return error('ბმულის დამატება ვერ მოხერხდა.', 500);
    const row = await env.DB.prepare(
      'SELECT pl.id, pl.position, pl.kind, pl.link_id, pl.title, pl.url, l.alias ' +
      'FROM profile_links pl LEFT JOIN links l ON l.id = pl.link_id WHERE pl.id = ?',
    ).bind(ins.meta.last_row_id).first();
    return json({ link: profileLinkToJson(request, row) }, 201);
  }

  // Reorder the profile buttons. ordered_ids must contain EXACTLY the
  // user's button ids (no foreign ids, none missing) — positions are
  // then rewritten 0..n in that order.
  if (path === '/api/profile/links/reorder' && method === 'POST') {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const profile = await env.DB.prepare(
      'SELECT user_id FROM profiles WHERE user_id = ?',
    ).bind(userSession.userId).first();
    if (!profile) return error('პროფილი არ მოიძებნა.', 404);
    const ids = parsed.body.ordered_ids;
    if (!Array.isArray(ids)) return error('ველის "ordered_ids" მასივი უნდა იყოს.', 400);
    const rows = await env.DB.prepare(
      'SELECT id FROM profile_links WHERE user_id = ?',
    ).bind(userSession.userId).all();
    const ownIds = new Set((rows.results || []).map((r) => r.id));
    const seen = new Set();
    for (const rawId of ids) {
      const id = parseInt(rawId, 10);
      if (!Number.isFinite(id) || !ownIds.has(id) || seen.has(id)) {
        return error('სია არასწორია — ყველა ბმული თქვენი უნდა იყოს.', 400);
      }
      seen.add(id);
    }
    if (seen.size !== ownIds.size) return error('სია არასრულია — ყველა ბმული უნდა იყოს შეტანილი.', 400);
    const stmts = ids.map((rawId, i) => env.DB.prepare(
      'UPDATE profile_links SET position = ? WHERE id = ? AND user_id = ?',
    ).bind(i, parseInt(rawId, 10), userSession.userId));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  // Edit / delete one profile button. Ownership is enforced; the URL
  // is editable only for manual buttons (short buttons keep pointing
  // at their link — its destination never changes here).
  const profileLinkMatch = path.match(/^\/api\/profile\/links\/(\d+)$/);
  if (profileLinkMatch) {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    const id = parseInt(profileLinkMatch[1], 10);
    const row = await env.DB.prepare(
      'SELECT user_id, kind FROM profile_links WHERE id = ?',
    ).bind(id).first();
    if (!row) return error('ბმული არ მოიძებნა.', 404);
    if (row.user_id !== userSession.userId) return error('ეს ბმული თქვენ არ გეკუთვნით.', 403);
    if (method === 'PATCH') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
      const parsed = await readJson(request);
      if (!parsed.ok) return error(parsed.reason, 400);
      const updates = [];
      const values = [];
      if ('title' in parsed.body) {
        const tv = validateProfileText(parsed.body.title, CONFIG.profileMaxTitle, 'სათაური', false);
        if (!tv.ok) return error(tv.reason, 400);
        updates.push('title = ?');
        values.push(tv.value);
      }
      if ('url' in parsed.body) {
        if (row.kind !== 'manual') return error('მოკლე ბმულის მისამართი არ იცვლება.', 400);
        const uv = validateProfileManualUrl(parsed.body.url);
        if (!uv.ok) return error(uv.reason, 400);
        updates.push('url = ?');
        values.push(uv.url);
      }
      if (updates.length === 0) return error('შესაცვლელი არაფერია.', 400);
      values.push(id);
      await env.DB.prepare(
        `UPDATE profile_links SET ${updates.join(', ')} WHERE id = ?`,
      ).bind(...values).run();
      const fresh = await env.DB.prepare(
        'SELECT pl.id, pl.position, pl.kind, pl.link_id, pl.title, pl.url, l.alias ' +
        'FROM profile_links pl LEFT JOIN links l ON l.id = pl.link_id WHERE pl.id = ?',
      ).bind(id).first();
      return json({ link: profileLinkToJson(request, fresh) });
    }
    if (method === 'DELETE') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      if (!await profileWriteAllowed(userSession.userId)) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
      await env.DB.prepare('DELETE FROM profile_links WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    return error('მეთოდი დაუშვებელია.', 405);
  }

  // --- Everything below requires a session ---------------------------
  const session = await getSession(env, request);
  if (!session) return error('შესვლა საჭიროა.', 401);

  if (path === '/api/logout' && method === 'POST') {
    await destroySession(env, request);
    const secure = new URL(request.url).protocol === 'https:';
    return json({ ok: true }, 200, {
      'Set-Cookie': `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`,
    });
  }

  // --- Revoke ALL sessions (e.g. right after changing the admin password) ---
  if (path === '/api/sessions' && method === 'DELETE') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    await env.DB.prepare('DELETE FROM sessions').run();
    return json({ ok: true });
  }

  // Generic per-minute limit for authenticated API calls.
  const apiOk = await checkRateLimit(request, env, 'api', CONFIG.apiMaxPerMin, 60);
  if (!apiOk) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);

  // --- List links ------------------------------------------------------
  // v2: each row also carries its owner (username, or null = anonymous).
  if (path === '/api/links' && method === 'GET') {
    const search = (url.searchParams.get('search') || '').trim();
    const linkSort = { newest: 'l.created_at DESC', oldest: 'l.created_at ASC', clicks_desc: 'l.clicks DESC, l.created_at DESC', clicks_asc: 'l.clicks ASC, l.created_at DESC' };
    const linkOrder = linkSort[url.searchParams.get('sort')] || linkSort.newest;
    let rows;
    if (search) {
      const like = '%' + search.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      rows = await env.DB.prepare(
        'SELECT l.id, l.alias, l.destination, l.created_at, l.expires_at, l.enabled, l.clicks, l.note, u.username AS owner ' +
        'FROM links l LEFT JOIN users u ON u.id = l.user_id ' +
        'WHERE l.alias LIKE ? ESCAPE \'\\\' OR l.destination LIKE ? ESCAPE \'\\\' OR l.note LIKE ? ESCAPE \'\\\' ' +
        'ORDER BY ' + linkOrder + ' LIMIT ?',
      ).bind(like, like, like, CONFIG.maxLinksList).all();
    } else {
      rows = await env.DB.prepare(
        'SELECT l.id, l.alias, l.destination, l.created_at, l.expires_at, l.enabled, l.clicks, l.note, u.username AS owner ' +
        'FROM links l LEFT JOIN users u ON u.id = l.user_id ' +
        'ORDER BY ' + linkOrder + ' LIMIT ?',
      ).bind(CONFIG.maxLinksList).all();
    }
    return json({ links: (rows.results || []).map((r) => linkRowToJson(request, r)) });
  }

  // --- v5 (admin): all users' QR favorites -----------------------------
  // v6: the admin sees EVERY generated QR (qr_history), not just saved
  // favorites — like links. `favorite` marks rows the user also saved.
  // Anonymous generations show with owner null ("ანონიმური").
  if (path === '/api/qr-favorites' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT q.id, q.user_id, q.type, q.label, q.payload, q.fg, q.bg, q.favorite, q.created_at, u.username AS owner ' +
      'FROM qr_history q LEFT JOIN users u ON u.id = q.user_id ' +
      'ORDER BY q.created_at DESC LIMIT 500',
    ).all();
    return json({
      favorites: (rows.results || []).map((r) => ({
        id: r.id,
        type: r.type,
        label: r.label,
        payload: r.payload,
        fg: r.fg,
        bg: r.bg,
        favorite: r.favorite === 1,
        createdAt: r.created_at,
        owner: r.owner || null,
      })),
    });
  }

  const qrFavAdminMatch = path.match(/^\/api\/qr-favorites\/(\d+)$/);
  if (qrFavAdminMatch) {
    if (method !== 'DELETE') return error('მეთოდი დაუშვებელია.', 405);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const id = parseInt(qrFavAdminMatch[1], 10);
    const row = await env.DB.prepare('SELECT user_id, payload FROM qr_history WHERE id = ?').bind(id).first();
    if (!row) return error('QR კოდი არ მოიძებნა.', 404);
    await env.DB.prepare('DELETE FROM qr_history WHERE id = ?').bind(id).run();
    // If it was saved as a favorite, remove it from the user's favorites too.
    if (row.user_id !== null && row.user_id !== undefined) {
      await env.DB.prepare(
        'DELETE FROM qr_favorites WHERE user_id = ? AND payload = ?',
      ).bind(row.user_id, row.payload).run();
    }
    return json({ ok: true });
  }

  // --- Check alias availability ----------------------------------------
  if (path === '/api/check-alias' && method === 'GET') {
    const alias = url.searchParams.get('alias') || '';
    const v = validateCustomAlias(alias);
    if (!v.ok) return json({ available: false, reason: v.reason });
    const row = await env.DB.prepare('SELECT 1 AS x FROM links WHERE alias = ?').bind(v.alias).first();
    if (row) return json({ available: false, reason: 'ეს სახელი დაკავებულია.' });
    return json({ available: true });
  }

  // --- Create link -------------------------------------------------------
  if (path === '/api/links' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const { destination, alias, expiresAt } = parsed.body;

    const v = validateDestination(destination, ownHosts(request));
    if (!v.ok) return error(v.reason, 400);
    const nv = validateNote(parsed.body.note);
    if (!nv.ok) return error(nv.reason, 400);

    let expiresMs = null;
    if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
      const n = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
      if (!Number.isFinite(n)) return error('ვადის თარიღი არასწორია.', 400);
      if (n <= Date.now()) return error('ვადა მომავალში უნდა იყოს.', 400);
      expiresMs = n;
    }

    let finalAlias;
    if (alias !== undefined && alias !== null && String(alias).trim() !== '') {
      const av = validateCustomAlias(alias);
      if (!av.ok) return error(av.reason, 400);
      finalAlias = av.alias;
      try {
        const ins = await env.DB.prepare(
          'INSERT INTO links (alias, destination, created_at, expires_at, enabled, clicks, user_id, note) ' +
          'VALUES (?, ?, ?, ?, 1, 0, NULL, ?)',
        ).bind(finalAlias, v.url, Date.now(), expiresMs, nv.note).run();
        if (!ins.success) return error('ბმულის შექმნა ვერ მოხერხდა.', 500);
      } catch (e) {
        if (String(e && e.message ? e.message : e).includes('UNIQUE')) {
          return error('ეს სახელი უკვე დაკავებულია.', 409);
        }
        throw e;
      }
    } else {
      const inserted = await insertAutoLink(env, v.url, expiresMs, null, nv.note);
      if (!inserted) return error('ბმულის შექმნა ვერ მოხერხდა — სცადეთ ხელახლა.', 500);
      finalAlias = inserted;
    }

    const row = await env.DB.prepare(
      'SELECT id, alias, destination, created_at, expires_at, enabled, clicks, note FROM links WHERE alias = ?',
    ).bind(finalAlias).first();
    return json({ link: linkRowToJson(request, row) }, 201);
  }

  // --- v3: recent clicks across ALL links (admin only) ----------------
  if (path === '/api/clicks/recent' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT c.clicked_at, l.alias, l.destination, l.note ' +
      'FROM click_events c JOIN links l ON l.id = c.link_id ' +
      'ORDER BY c.clicked_at DESC, c.id DESC LIMIT 20',
    ).all();
    return json({
      clicks: (rows.results || []).map((r) => ({
        clickedAt: r.clicked_at,
        alias: r.alias,
        shortUrl: publicLink(request, r.alias),
        destination: r.destination,
        note: r.note !== undefined && r.note !== null ? r.note : '',
      })),
    });
  }

  // --- v3: click history of one link (admin only) ----------------------
  const linkClicksMatch = path.match(/^\/api\/links\/(\d+)\/clicks$/);
  if (linkClicksMatch) {
    if (method !== 'GET') return error('მეთოდი დაუშვებელია.', 405);
    const id = parseInt(linkClicksMatch[1], 10);
    const exists = await env.DB.prepare('SELECT id FROM links WHERE id = ?').bind(id).first();
    if (!exists) return error('ბმული არ მოიძებნა.', 404);
    const rows = await env.DB.prepare(
      'SELECT clicked_at FROM click_events WHERE link_id = ? ' +
      'ORDER BY clicked_at DESC, id DESC LIMIT 50',
    ).bind(id).all();
    return json({ events: (rows.results || []).map((r) => ({ clickedAt: r.clicked_at })) });
  }

  // --- Update / delete one link ------------------------------------------
  const linkIdMatch = path.match(/^\/api\/links\/(\d+)$/);
  if (linkIdMatch) {
    const id = parseInt(linkIdMatch[1], 10);
    if (method === 'PATCH') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      const parsed = await readJson(request);
      if (!parsed.ok) return error(parsed.reason, 400);
      const updates = [];
      const values = [];
      if (typeof parsed.body.enabled === 'boolean') {
        updates.push('enabled = ?');
        values.push(parsed.body.enabled ? 1 : 0);
      }
      if ('expiresAt' in parsed.body) {
        const e = parsed.body.expiresAt;
        if (e === null || e === '') {
          updates.push('expires_at = NULL');
        } else {
          const n = typeof e === 'number' ? e : Date.parse(e);
          if (!Number.isFinite(n)) return error('ვადის თარიღი არასწორია.', 400);
          if (n <= Date.now()) return error('ვადა მომავალში უნდა იყოს.', 400);
          updates.push('expires_at = ?');
          values.push(n);
        }
      }
      if ('note' in parsed.body) {
        const nv = validateNote(parsed.body.note);
        if (!nv.ok) return error(nv.reason, 400);
        if (nv.note === null) updates.push('note = NULL');
        else { updates.push('note = ?'); values.push(nv.note); }
      }
      if (updates.length === 0) return error('შესაცვლელი არაფერია.', 400);
      values.push(id);
      const res = await env.DB.prepare(
        `UPDATE links SET ${updates.join(', ')} WHERE id = ?`,
      ).bind(...values).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('ბმული არ მოიძებნა.', 404);
      }
      const row = await env.DB.prepare(
        'SELECT id, alias, destination, created_at, expires_at, enabled, clicks, note FROM links WHERE id = ?',
      ).bind(id).first();
      return json({ link: linkRowToJson(request, row) });
    }
    if (method === 'DELETE') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      // v8.0: drop profile buttons that pointed at the link FIRST —
      // deleting the link row first would violate the profile_links
      // foreign key where FK enforcement is on. Best-effort: the
      // profiles table may not exist yet.
      try {
        await env.DB.prepare('DELETE FROM profile_links WHERE link_id = ?').bind(id).run();
      } catch { /* ignore */ }
      const res = await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('ბმული არ მოიძებნა.', 404);
      }
      return json({ ok: true });
    }
    return error('მეთოდი დაუშვებელია.', 405);
  }

  // --- Export all links (backup) -------------------------------------------
  if (path === '/api/export' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT alias, destination, created_at, expires_at, enabled, clicks, note FROM links ORDER BY created_at ASC',
    ).all();
    return json({
      exportedAt: new Date().toISOString(),
      version: 1,
      links: rows.results || [],
    });
  }

  // --- Import links (restore) ------------------------------------------------
  if (path === '/api/import' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const items = parsed.body.links;
    if (!Array.isArray(items)) return error('ველის "links" მასივი უნდა იყოს.', 400);
    if (items.length > CONFIG.maxImportLinks) {
      return error(`ერთ იმპორტში მაქს. ${CONFIG.maxImportLinks} ბმული შეიძლება.`, 400);
    }
    const hosts = ownHosts(request);
    let inserted = 0;
    let skipped = 0;
    let invalid = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') { invalid++; continue; }
      const v = validateDestination(item.destination, hosts);
      if (!v.ok) { invalid++; continue; }
      const av = validateCustomAlias(item.alias || '');
      if (!av.ok) { invalid++; continue; }
      const createdAt = Number.isFinite(item.created_at) ? item.created_at : Date.now();
      const expiresMs = Number.isFinite(item.expires_at) ? item.expires_at : null;
      const enabled = item.enabled === 0 || item.enabled === false ? 0 : 1;
      const clicks = Number.isFinite(item.clicks) && item.clicks >= 0 ? Math.floor(item.clicks) : 0;
      const nv = validateNote(item.note);
      const note = nv.ok ? nv.note : null;
      try {
        const ins = await env.DB.prepare(
          'INSERT OR IGNORE INTO links (alias, destination, created_at, expires_at, enabled, clicks, note) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(av.alias, v.url, createdAt, expiresMs, enabled, clicks, note).run();
        if (ins.meta && ins.meta.changes === 1) inserted++;
        else skipped++;
      } catch {
        invalid++;
      }
    }
    return json({ inserted, skipped, invalid });
  }

  // --- Admin: list users -------------------------------------------------
  // Never returns password hashes. link_count counts the user's own links,
  // qr_count counts the user's saved QR codes (v5 favorites). v8.0 adds
  // the profile summary (has_profile + button count/limit/view count) so
  // the user modal can show the profile section without another call.
  if (path === '/api/admin/users' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT u.id, u.username, u.email, u.email_verified, u.disabled, u.created_at, ' +
      '(SELECT COUNT(*) FROM links WHERE user_id = u.id) AS link_count, ' +
      '(SELECT COUNT(*) FROM qr_favorites WHERE user_id = u.id) AS qr_count, ' +
      'EXISTS (SELECT 1 FROM profiles WHERE user_id = u.id) AS has_profile, ' +
      '(SELECT COUNT(*) FROM profile_links WHERE user_id = u.id) AS profile_link_count, ' +
      '(SELECT link_limit FROM profiles WHERE user_id = u.id) AS profile_link_limit, ' +
      '(SELECT view_count FROM profiles WHERE user_id = u.id) AS profile_view_count ' +
      'FROM users u ORDER BY u.created_at DESC',
    ).all();
    return json({
      users: (rows.results || []).map((r) => ({
        id: r.id,
        username: r.username,
        email: r.email,
        emailVerified: r.email_verified === 1,
        disabled: r.disabled === 1,
        createdAt: r.created_at,
        linkCount: r.link_count,
        qrCount: r.qr_count,
        hasProfile: r.has_profile === 1,
        profileLinkCount: r.profile_link_count || 0,
        profileLinkLimit: r.profile_link_limit === null || r.profile_link_limit === undefined ? null : r.profile_link_limit,
        profileViewCount: r.profile_view_count || 0,
      })),
    });
  }

  // --- v10.0: visitor IPs (admin only; never exposed publicly) ---------
  if (path === '/api/admin/visitors' && method === 'GET') {
    const visitorSort = {
      last_desc: 'last_seen DESC',
      last_asc: 'last_seen ASC',
      visits_desc: 'visits DESC, last_seen DESC',
      visits_asc: 'visits ASC, last_seen DESC',
      first_desc: 'first_seen DESC',
      first_asc: 'first_seen ASC',
    };
    const orderBy = visitorSort[url.searchParams.get('sort')] || visitorSort.last_desc;
    const q = (url.searchParams.get('q') || '').trim();
    await env.DB.prepare(
      'DELETE FROM visitors WHERE last_seen < ?',
    ).bind(Date.now() - CONFIG.visitorRetentionMs).run();
    await env.DB.prepare(
      'DELETE FROM visitor_users WHERE last_seen < ?',
    ).bind(Date.now() - CONFIG.visitorRetentionMs).run();
    let rows;
    if (q) {
      const like = '%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      rows = await env.DB.prepare(
        'SELECT ip, visits, first_seen, last_seen, last_path, country, city, region, postal_code, latitude, longitude, timezone, isp, asn, is_eu, browser, os, device, language, referrer, note FROM visitors ' +
        'WHERE ip LIKE ? ESCAPE \'\\\' OR country LIKE ? ESCAPE \'\\\' OR city LIKE ? ESCAPE \'\\\' OR region LIKE ? ESCAPE \'\\\' OR isp LIKE ? ESCAPE \'\\\' OR browser LIKE ? ESCAPE \'\\\' OR os LIKE ? ESCAPE \'\\\' OR device LIKE ? ESCAPE \'\\\' OR language LIKE ? ESCAPE \'\\\' OR referrer LIKE ? ESCAPE \'\\\' OR note LIKE ? ESCAPE \'\\\' ORDER BY ' + orderBy + ' LIMIT ?',
      ).bind(like, like, like, like, like, like, like, like, like, like, like, CONFIG.maxVisitorsList).all();
    } else {
      rows = await env.DB.prepare(
        'SELECT ip, visits, first_seen, last_seen, last_path, country, city, region, postal_code, latitude, longitude, timezone, isp, asn, is_eu, browser, os, device, language, referrer, note FROM visitors ' +
        'ORDER BY ' + orderBy + ' LIMIT ?',
      ).bind(CONFIG.maxVisitorsList).all();
    }
    const totals = await env.DB.prepare(
      'SELECT COUNT(*) AS c, COALESCE(SUM(visits), 0) AS s FROM visitors',
    ).first();
    // v10.2: usernames seen from each IP (logged-in visits only).
    const userRows = await env.DB.prepare(
      'SELECT vu.ip, u.username, vu.last_seen FROM visitor_users vu ' +
      'JOIN users u ON u.id = vu.user_id ORDER BY vu.last_seen DESC',
    ).all();
    const usersByIp = new Map();
    for (const ur of (userRows.results || [])) {
      if (!usersByIp.has(ur.ip)) usersByIp.set(ur.ip, []);
      usersByIp.get(ur.ip).push({ username: ur.username, lastSeen: ur.last_seen });
    }
    return json({
      visitors: (rows.results || []).map((r) => ({
        ip: r.ip,
        visits: r.visits,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        lastPath: r.last_path,
        country: r.country || null,
        city: r.city || null,
        region: r.region || null,
        postalCode: r.postal_code || null,
        latitude: r.latitude === null || r.latitude === undefined ? null : r.latitude,
        longitude: r.longitude === null || r.longitude === undefined ? null : r.longitude,
        timezone: r.timezone || null,
        isp: r.isp || null,
        asn: r.asn === null || r.asn === undefined ? null : r.asn,
        isEu: r.is_eu === 1,
        browser: r.browser || null,
        os: r.os || null,
        device: r.device || null,
        language: r.language || null,
        referrer: r.referrer || null,
        note: r.note || null,
        users: usersByIp.get(r.ip) || [],
      })),
      totalDevices: totals ? totals.c : 0,
      totalVisits: totals ? totals.s : 0,
    });
  }
  // --- v10.4: admin note on a visitor IP (admin only) ------------------
  if (path === '/api/admin/visitors' && method === 'PATCH') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const ip = parsed.body.ip;
    const note = parsed.body.note;
    if (typeof ip !== 'string' || !ip || ip.length > 45) return error('არასწორი IP.', 400);
    if (typeof note !== 'string' || note.length > CONFIG.visitorNoteMaxChars) return error('შენიშვნა არასწორია.', 400);
    const clean = note.trim();
    const res = await env.DB.prepare(
      'UPDATE visitors SET note = ? WHERE ip = ?',
    ).bind(clean === '' ? null : clean, ip).run();
    if (!res.success || res.meta.changes === 0) return error('სტუმარი ვერ მოიძებნა.', 404);
    return json({ ok: true });
  }
  if (path === '/api/admin/visitors' && method === 'DELETE') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const ip = (url.searchParams.get('ip') || '').trim();
    if (ip) {
      if (ip.length > 45) return error('არასწორი IP.', 400);
      const res = await env.DB.prepare('DELETE FROM visitors WHERE ip = ?').bind(ip).run();
      await env.DB.prepare('DELETE FROM visitor_users WHERE ip = ?').bind(ip).run();
      return json({ ok: true, deleted: res.meta ? res.meta.changes : 0 });
    }
    const res = await env.DB.prepare('DELETE FROM visitors').run();
    await env.DB.prepare('DELETE FROM visitor_users').run();
    return json({ ok: true, deleted: res.meta ? res.meta.changes : 0 });
  }

  // --- v10.3: visit-hours histogram (admin only) -----------------------
  if (path === '/api/admin/visit-hours' && method === 'GET') {
    const period = url.searchParams.get('period') || 'today';
    const { day, cutoffDay } = tbilisiDayHour(Date.now());
    await env.DB.prepare('DELETE FROM visit_hours WHERE day < ?').bind(cutoffDay).run();
    let fromDay = day;
    if (period === '7d') fromDay = tbilisiDayHour(Date.now() - 6 * 86400000).day;
    else if (period === '30d') fromDay = cutoffDay;
    const rows = await env.DB.prepare(
      'SELECT hour, SUM(visits) AS v FROM visit_hours WHERE day >= ? GROUP BY hour ORDER BY hour ASC',
    ).bind(fromDay).all();
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, visits: 0 }));
    for (const r of (rows.results || [])) hours[r.hour].visits = r.v;
    return json({ hours, period: period === '7d' || period === '30d' ? period : 'today' });
  }
  // --- v10.3: popular pages (admin only) -------------------------------
  if (path === '/api/admin/path-stats' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT path, visits, last_seen FROM path_stats ORDER BY visits DESC, last_seen DESC LIMIT 100',
    ).all();
    return json({ pages: (rows.results || []).map((r) => ({ path: r.path, visits: r.visits, lastSeen: r.last_seen })) });
  }
  // --- v10.3: screen sizes (admin only) --------------------------------
  if (path === '/api/admin/screen-stats' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT resolution, visits FROM screen_stats ORDER BY visits DESC LIMIT 50',
    ).all();
    return json({ screens: (rows.results || []).map((r) => ({ resolution: r.resolution, visits: r.visits })) });
  }

  // --- v10.4: behavior events for one IP (admin only) ------------------
  if (path === '/api/admin/visitor-events' && method === 'GET') {
    const ip = url.searchParams.get('ip') || '';
    if (!ip || ip.length > 45) return error('არასწორი IP.', 400);
    await env.DB.prepare(
      'DELETE FROM visit_events WHERE created_at < ?',
    ).bind(Date.now() - CONFIG.visitorRetentionMs).run();
    const rows = await env.DB.prepare(
      'SELECT id, session, type, path, label, seconds, scroll, created_at FROM visit_events ' +
      'WHERE ip = ? ORDER BY created_at DESC, id DESC LIMIT 50',
    ).bind(ip).all();
    return json({ events: (rows.results || []).map((r) => ({
      id: r.id,
      session: r.session,
      type: r.type,
      path: r.path,
      label: r.label,
      seconds: r.seconds,
      scroll: r.scroll,
      createdAt: r.created_at,
    })) });
  }

  // --- v10.1: excluded IPs (admin only) --------------------------------
  if (path === '/api/admin/ip-exclusions' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT ip, created_at FROM ip_exclusions ORDER BY created_at DESC',
    ).all();
    return json({
      exclusions: (rows.results || []).map((r) => ({ ip: r.ip, createdAt: r.created_at })),
    });
  }
  if (path === '/api/admin/ip-exclusions' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const ip = typeof parsed.body.ip === 'string' ? parsed.body.ip.trim() : '';
    if (!isValidIp(ip)) return error('არასწორი IP მისამართი.', 400);
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO ip_exclusions (ip, created_at) VALUES (?, ?)',
    ).bind(ip, Date.now()).run();
    const added = res.meta ? res.meta.changes > 0 : false;
    // Adding an exclusion also removes the IP from the visitors list.
    await env.DB.prepare('DELETE FROM visitors WHERE ip = ?').bind(ip).run();
    await env.DB.prepare('DELETE FROM visitor_users WHERE ip = ?').bind(ip).run();
    return json({ ok: true, added });
  }
  if (path === '/api/admin/ip-exclusions' && method === 'DELETE') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const ip = (url.searchParams.get('ip') || '').trim();
    if (!ip) return error('IP მისამართი საჭიროა.', 400);
    const res = await env.DB.prepare('DELETE FROM ip_exclusions WHERE ip = ?').bind(ip).run();
    return json({ ok: true, deleted: res.meta ? res.meta.changes : 0 });
  }

  // --- Admin: disable/enable or delete one user --------------------------
  const adminUserMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (adminUserMatch) {
    const userId = parseInt(adminUserMatch[1], 10);
    if (method === 'PATCH') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      const parsed = await readJson(request);
      if (!parsed.ok) return error(parsed.reason, 400);
      if (typeof parsed.body.disabled !== 'boolean') {
        return error('ველის "disabled" მნიშვნელობა true ან false უნდა იყოს.', 400);
      }
      const disabled = parsed.body.disabled ? 1 : 0;
      const res = await env.DB.prepare(
        'UPDATE users SET disabled = ? WHERE id = ?',
      ).bind(disabled, userId).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('მომხმარებელი არ მოიძებნა.', 404);
      }
      if (disabled === 1) {
        // A disabled user is logged out everywhere immediately.
        await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();
      }
      const row = await env.DB.prepare(
        'SELECT id, username, email, email_verified, disabled, created_at FROM users WHERE id = ?',
      ).bind(userId).first();
      return json({ user: userToJson(row) });
    }
    if (method === 'DELETE') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      const exists = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
      if (!exists) return error('მომხმარებელი არ მოიძებნა.', 404);
      // The user's short links become anonymous and KEEP redirecting —
      // deleting a user must never break links already shared.
      const anon = await env.DB.prepare(
        'UPDATE links SET user_id = NULL WHERE user_id = ?',
      ).bind(userId).run();
      await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM email_codes WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM visitor_users WHERE user_id = ?').bind(userId).run();
      // v8.0: the user's profile + buttons go with the account. The
      // avatar R2 object is deleted best-effort — a leftover orphan
      // object is harmless (unguessable key, no references left).
      try {
        const prof = await env.DB.prepare('SELECT avatar_r2_key FROM profiles WHERE user_id = ?').bind(userId).first();
        await env.DB.prepare('DELETE FROM profile_links WHERE user_id = ?').bind(userId).run();
        await env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(userId).run();
        if (prof && prof.avatar_r2_key && env.CHAT_FILES) {
          try { await env.CHAT_FILES.delete(prof.avatar_r2_key); } catch { /* best-effort */ }
        }
      } catch { /* profiles table may not exist yet */ }
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      return json({ ok: true, linksAnonymized: (anon.meta && anon.meta.changes) || 0 });
    }
    return error('მეთოდი დაუშვებელია.', 405);
  }

  // --- v8.0: admin sets one user's profile button limit --------------
  // The limit lives on the profiles row, so a user without a profile
  // gets 404 profile_not_found — the admin grants extra buttons only
  // to existing profiles (the user asks via the admin chat).
  const adminLinkLimitMatch = path.match(/^\/api\/admin\/users\/(\d+)\/link-limit$/);
  if (adminLinkLimitMatch) {
    if (method !== 'POST') return error('მეთოდი დაუშვებელია.', 405);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const userId = parseInt(adminLinkLimitMatch[1], 10);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const limit = parsed.body.link_limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > CONFIG.profileMaxLinkLimit) {
      return error(`ლიმიტი 1–${CONFIG.profileMaxLinkLimit} შორის უნდა იყოს.`, 400);
    }
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!user) return error('მომხმარებელი არ მოიძებნა.', 404);
    const profile = await env.DB.prepare(
      'SELECT user_id FROM profiles WHERE user_id = ?',
    ).bind(userId).first();
    if (!profile) {
      return json({ error: 'profile_not_found', message: 'მომხმარებელს პროფილი არ აქვს შექმნილი.' }, 404);
    }
    await env.DB.prepare(
      'UPDATE profiles SET link_limit = ?, updated_at = ? WHERE user_id = ?',
    ).bind(limit, new Date().toISOString(), userId).run();
    return json({ ok: true, linkLimit: limit });
  }

  // --- v7.0/v7.1: admin chat — admin side ---------------------------
  // Behind the admin session gate (above). One thread per user; the
  // admin sees all threads, sends text + files + links, and can delete
  // a thread (messages + attachments). The LEFT JOIN keeps threads of
  // deleted users visible (username null) so they can still be removed.
  // v7.1: the users list (GET /api/admin/chat/users) is the primary
  // view; threads are created empty via POST /api/admin/chat/threads
  // on the first explicit send — opening a chat never sends anything.

  if (path === '/api/admin/chat/threads' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT t.id, t.user_id, t.created_at, t.last_message_at, t.admin_unread, t.user_unread, ' +
      'u.username, u.email, u.email_verified, u.disabled, ' +
      '(SELECT body FROM chat_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body, ' +
      '(SELECT sender FROM chat_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_sender ' +
      'FROM chat_threads t LEFT JOIN users u ON u.id = t.user_id ' +
      'ORDER BY t.last_message_at DESC',
    ).all();
    return json({
      threads: (rows.results || []).map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username || null,
        email: r.email || null,
        emailVerified: r.email_verified === 1,
        disabled: r.disabled === 1,
        createdAt: r.created_at,
        lastMessageAt: r.last_message_at,
        adminUnread: r.admin_unread,
        userUnread: r.user_unread,
        lastBody: r.last_body || '',
        lastSender: r.last_sender || null,
      })),
    });
  }

  // v7.1: every email-verified, enabled user with their thread
  // summary (if any) — the chat tab's users list. Unverified and
  // disabled users never appear. Users with threads come first,
  // most recent first; users without a thread follow, by username.
  // Read-only: listing never creates threads or messages.
  if (path === '/api/admin/chat/users' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT u.id, u.username, u.email, ' +
      't.id AS thread_id, t.last_message_at, t.admin_unread, t.user_unread, ' +
      '(SELECT body FROM chat_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_body, ' +
      '(SELECT sender FROM chat_messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_sender ' +
      'FROM users u LEFT JOIN chat_threads t ON t.user_id = u.id ' +
      'WHERE u.email_verified = 1 AND u.disabled = 0 ' +
      'ORDER BY CASE WHEN t.id IS NULL THEN 1 ELSE 0 END, t.last_message_at DESC, u.username ASC',
    ).all();
    return json({
      users: (rows.results || []).map((r) => ({
        id: r.id,
        username: r.username,
        email: r.email,
        threadId: r.thread_id || null,
        lastMessageAt: r.last_message_at || null,
        adminUnread: r.admin_unread || 0,
        userUnread: r.user_unread || 0,
        lastBody: r.last_body || '',
        lastSender: r.last_sender || null,
      })),
    });
  }

  // v7.1: create (or get) the empty thread row for a user. Creates
  // ONLY the row — never a message. The admin UI calls this on the
  // first explicit send to a user with no thread yet; opening a chat
  // is read-only and never calls it.
  if (path === '/api/admin/chat/threads' && method === 'POST') {
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const threadOk = await rateLimit(env, 'chat-admin-thread', CONFIG.chatAdminMaxPerMin, 60);
    if (!threadOk) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const userId = parseInt(parsed.body.userId, 10);
    if (!Number.isFinite(userId) || userId <= 0) return error('მომხმარებელი არასწორია.', 400);
    const user = await env.DB.prepare(
      'SELECT id, email_verified, disabled FROM users WHERE id = ?',
    ).bind(userId).first();
    if (!user) return error('მომხმარებელი არ მოიძებნა.', 404);
    if (user.email_verified !== 1) return error('ჩატი მხოლოდ მეილზე დადასტურებულ მომხმარებლებთან შეიძლება.', 403);
    if (user.disabled === 1) return error('მომხმარებელი გათიშულია.', 403);
    const thread = await getOrCreateChatThread(env, userId);
    if (!thread) return error('ჩატის შექმნა ვერ მოხერხდა.', 500);
    return json({ threadId: thread.id });
  }

  const chatThreadMatch = path.match(/^\/api\/admin\/chat\/threads\/(\d+)$/);
  if (chatThreadMatch) {
    const threadId = parseInt(chatThreadMatch[1], 10);
    const thread = await env.DB.prepare(
      'SELECT t.id, t.user_id, t.created_at, t.last_message_at, t.admin_unread, t.user_unread, ' +
      'u.username, u.email, u.email_verified, u.disabled ' +
      'FROM chat_threads t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?',
    ).bind(threadId).first();
    if (!thread) return error('ჩატი არ მოიძებნა.', 404);
    if (method === 'GET') {
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const messages = await listChatMessages(env, threadId, after);
      return json({
        thread: {
          id: thread.id,
          userId: thread.user_id,
          username: thread.username || null,
          email: thread.email || null,
          emailVerified: thread.email_verified === 1,
          disabled: thread.disabled === 1,
          createdAt: thread.created_at,
          lastMessageAt: thread.last_message_at,
          adminUnread: thread.admin_unread,
          userUnread: thread.user_unread,
        },
        messages,
      });
    }
    if (method === 'DELETE') {
      if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
      // Collect the R2 keys FIRST so the objects can be removed too
      // (v7.3+ rows; legacy rows have no r2_key). Best-effort: a
      // failed lookup must not block deleting the thread itself.
      let r2Keys = [];
      try {
        const keyRows = await env.DB.prepare(
          'SELECT a.r2_key FROM chat_attachments a ' +
          'JOIN chat_messages m ON m.id = a.message_id ' +
          'WHERE m.thread_id = ? AND a.r2_key IS NOT NULL',
        ).bind(threadId).all();
        r2Keys = (keyRows.results || []).map((r) => r.r2_key).filter(Boolean);
      } catch (e) {
        console.error('chat delete: r2_key lookup failed:', e && e.message ? e.message : e);
      }
      await env.DB.prepare(
        'DELETE FROM chat_attachments WHERE message_id IN (SELECT id FROM chat_messages WHERE thread_id = ?)',
      ).bind(threadId).run();
      await env.DB.prepare('DELETE FROM chat_messages WHERE thread_id = ?').bind(threadId).run();
      await env.DB.prepare('DELETE FROM chat_threads WHERE id = ?').bind(threadId).run();
      if (env.CHAT_FILES) {
        for (const key of r2Keys) {
          try { await env.CHAT_FILES.delete(key); } catch { /* best-effort, ignore missing */ }
        }
      }
      return json({ ok: true });
    }
    return error('მეთოდი დაუშვებელია.', 405);
  }

  const chatThreadSendMatch = path.match(/^\/api\/admin\/chat\/threads\/(\d+)\/send$/);
  if (chatThreadSendMatch) {
    if (method !== 'POST') return error('მეთოდი დაუშვებელია.', 405);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const adminOk = await rateLimit(env, 'chat-admin', CONFIG.chatAdminMaxPerMin, 60);
    if (!adminOk) return error('ძალიან ბევრი შეტყობინება. სცადეთ ერთ წუთში.', 429);
    const threadId = parseInt(chatThreadSendMatch[1], 10);
    const thread = await env.DB.prepare(
      'SELECT id, user_id FROM chat_threads WHERE id = ?',
    ).bind(threadId).first();
    if (!thread) return error('ჩატი არ მოიძებნა.', 404);
    const parsed = await readJson(request);
    if (!parsed.ok) return error(parsed.reason, 400);
    const body = typeof parsed.body.body === 'string' ? parsed.body.body.trim() : '';
    // v7.1: a link from the "+" menu arrives as linkUrl and is stored
    // as the message text. It is exclusive — a link goes out as its
    // own message, never bundled with text or a file.
    const lv = validateChatLinkUrl(parsed.body.linkUrl);
    if (!lv.ok) return error(lv.reason, 400);
    const av = validateChatAttachment(parsed.body.attachment);
    if (!av.ok) return error(av.reason, 400);
    // Fail LOUDLY when the R2 binding is missing: attachments must
    // never silently fall back to D1 blobs (that round-trip proved
    // corrupt on real D1). Text-only messages need no R2.
    if (av.attachment && !env.CHAT_FILES) {
      return error('ფაილების საცავი (R2) არ არის დაკავშირებული — დანართის გაგზავნა შეუძლებელია.', 500);
    }
    if (lv.url && (body || av.attachment)) return error('ლინკი ცალკე შეტყობინებად იგზავნება.', 400);
    const finalBody = lv.url || body;
    if (!finalBody && !av.attachment) return error('შეტყობინება ცარიელია.', 400);
    if (finalBody.length > CONFIG.chatMaxBodyChars) {
      return error(`შეტყობინება მაქს. ${CONFIG.chatMaxBodyChars} სიმბოლო შეიძლება იყოს.`, 400);
    }
    const message = await insertChatMessage(env, thread, 'admin', finalBody, av.attachment);
    return json({ message }, 201);
  }

  const chatThreadReadMatch = path.match(/^\/api\/admin\/chat\/threads\/(\d+)\/read$/);
  if (chatThreadReadMatch) {
    if (method !== 'POST') return error('მეთოდი დაუშვებელია.', 405);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const threadId = parseInt(chatThreadReadMatch[1], 10);
    const res = await env.DB.prepare(
      'UPDATE chat_threads SET admin_unread = 0 WHERE id = ?',
    ).bind(threadId).run();
    if (!res.success || (res.meta && res.meta.changes === 0)) return error('ჩატი არ მოიძებნა.', 404);
    return json({ ok: true });
  }

  return error('არ მოიძებნა.', 404);
}

/* ------------------------------------------------------------------ */
/* Main router                                                         */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/health') {
        return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
      }

      // Static frontend files.
      if (path === '/' || STATIC_TYPES[path]) {
        // v10.0: count document loads only (page views, not assets).
        if (path === '/' || path === '/index.html' || path === '/admin.html') {
          scheduleVisit(env, ctx, request, path);
        }
        const res = await serveStatic(env, request, path);
        if (res) return res;
        return new Response('Not found', { status: 404 });
      }

      // API.
      if (path.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }

      // v8.0: public profile pages /@username and avatars /@username/avatar.
      // Registered BEFORE the short-link redirect: aliases never contain
      // '@', so these paths can never be a link alias.
      const avatarMatch = path.match(/^\/@([A-Za-z0-9_.-]{3,32})\/avatar$/);
      if (request.method === 'GET' && avatarMatch) {
        return await handleProfileAvatar(request, env, avatarMatch[1]);
      }
      const profileMatch = path.match(/^\/@([A-Za-z0-9_.-]{3,32})$/);
      if (request.method === 'GET' && profileMatch) {
        const allowed = await checkRateLimit(request, env, 'profile-view', CONFIG.redirectMaxPerMin, 60);
        if (!allowed) return new Response('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', { status: 429 });
        scheduleVisit(env, ctx, request, path);
        return await handleProfilePage(request, env, profileMatch[1]);
      }

      // Public short-link redirect: /<alias>
      if (request.method === 'GET' && /^\/[A-Za-z0-9_-]{1,64}$/.test(path)) {
        const alias = decodeURIComponent(path.slice(1));
        if (RESERVED_ALIASES.has(alias.toLowerCase())) {
          return new Response('Not found', { status: 404 });
        }
        const allowed = await checkRateLimit(request, env, 'redirect', CONFIG.redirectMaxPerMin, 60);
        if (!allowed) return new Response('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', { status: 429 });
        scheduleVisit(env, ctx, request, path);
        return await handleRedirect(request, env, alias);
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      // Never leak stack traces or internals to clients.
      console.error('fetch error:', e && e.message ? e.message : e);
      return json({ error: 'სერვერის შეცდომა.' }, 500);
    }
  },
};
