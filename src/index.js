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

/* ------------------------------------------------------------------ */
/* Rate limiting (D1-backed, keyed by hashed IP — raw IP never stored) */
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
    return json({ ok: true, favorite: { id: res.meta.last_row_id, ...v.fav, created_at: now } }, 201);
  }

  const qrFavMatch = path.match(/^\/api\/auth\/qr-favorites\/(\d+)$/);
  if (qrFavMatch) {
    const userSession = await getUserSession(env, request);
    if (!userSession) return error('შესვლა საჭიროა.', 401);
    if (method !== 'DELETE') return error('მეთოდი დაუშვებელია.', 405);
    if (!originAllowed(request)) return error('არასწორი წყარო (Origin).', 403);
    const id = parseInt(qrFavMatch[1], 10);
    const own = await env.DB.prepare('SELECT user_id FROM qr_favorites WHERE id = ?').bind(id).first();
    if (!own) return error('რჩეული არ მოიძებნა.', 404);
    if (own.user_id !== userSession.userId) return error('ეს რჩეული თქვენ არ გეკუთვნით.', 403);
    const res = await env.DB.prepare('DELETE FROM qr_favorites WHERE id = ?').bind(id).run();
    if (!res.success || (res.meta && res.meta.changes === 0)) return error('რჩეული არ მოიძებნა.', 404);
    return json({ ok: true });
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
      const res = await env.DB.prepare('DELETE FROM links WHERE id = ?').bind(id).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('ბმული არ მოიძებნა.', 404);
      }
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
    let rows;
    if (search) {
      const like = '%' + search.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      rows = await env.DB.prepare(
        'SELECT l.id, l.alias, l.destination, l.created_at, l.expires_at, l.enabled, l.clicks, l.note, u.username AS owner ' +
        'FROM links l LEFT JOIN users u ON u.id = l.user_id ' +
        'WHERE l.alias LIKE ? ESCAPE \'\\\' OR l.destination LIKE ? ESCAPE \'\\\' OR l.note LIKE ? ESCAPE \'\\\' ' +
        'ORDER BY l.created_at DESC LIMIT ?',
      ).bind(like, like, like, CONFIG.maxLinksList).all();
    } else {
      rows = await env.DB.prepare(
        'SELECT l.id, l.alias, l.destination, l.created_at, l.expires_at, l.enabled, l.clicks, l.note, u.username AS owner ' +
        'FROM links l LEFT JOIN users u ON u.id = l.user_id ' +
        'ORDER BY l.created_at DESC LIMIT ?',
      ).bind(CONFIG.maxLinksList).all();
    }
    return json({ links: (rows.results || []).map((r) => linkRowToJson(request, r)) });
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
  // Never returns password hashes. link_count counts the user's own links.
  if (path === '/api/admin/users' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT u.id, u.username, u.email, u.email_verified, u.disabled, u.created_at, ' +
      '(SELECT COUNT(*) FROM links WHERE user_id = u.id) AS link_count ' +
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
      })),
    });
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
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      return json({ ok: true, linksAnonymized: (anon.meta && anon.meta.changes) || 0 });
    }
    return error('მეთოდი დაუშვებელია.', 405);
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
        const res = await serveStatic(env, request, path);
        if (res) return res;
        return new Response('Not found', { status: 404 });
      }

      // API.
      if (path.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }

      // Public short-link redirect: /<alias>
      if (request.method === 'GET' && /^\/[A-Za-z0-9_-]{1,64}$/.test(path)) {
        const alias = decodeURIComponent(path.slice(1));
        if (RESERVED_ALIASES.has(alias.toLowerCase())) {
          return new Response('Not found', { status: 404 });
        }
        const allowed = await checkRateLimit(request, env, 'redirect', CONFIG.redirectMaxPerMin, 60);
        if (!allowed) return new Response('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', { status: 429 });
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
