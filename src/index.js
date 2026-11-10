/**
 * URL Shortener — Cloudflare Worker (backend + hosting)
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
  // Rate limits (per hashed IP).
  loginMaxAttempts: 5, // per 10 minutes
  loginWindowSec: 600,
  apiMaxPerMin: 60,
  redirectMaxPerMin: 120,
  maxLinksList: 200,
  maxImportLinks: 500,
};

// Short-code namespaces that must never be usable as aliases (they are routes).
const RESERVED_ALIASES = new Set([
  'api', 'admin', 'login', 'logout', 'static', 'assets', 'dashboard',
  'qr', 'export', 'import', 'health', 'robots.txt', 'favicon.ico',
  'sitemap.xml', 'index.html', 'app.js', 'styles.css', 'qrcode.min.js',
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
 *  - must not point at this shortener's own host (self-redirect loop)
 *  - must not be another URL shortener (redirect-chain abuse)
 *  - blocked TLDs, brand-impersonation lookalikes (see lists above)
 */
function validateDestination(raw, ownHost) {
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
  if (ownHost && (host === ownHost || host.endsWith('.' + ownHost))) {
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

function publicLink(request, alias) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}/${alias}`;
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
  };
}

/* ------------------------------------------------------------------ */
/* Static frontend (ASSETS binding, or embedded copy in single-file build) */
/* ------------------------------------------------------------------ */

const STATIC_TYPES = {
  '/index.html': 'text/html; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/qrcode.min.js': 'text/javascript; charset=utf-8',
  '/favicon.ico': 'image/x-icon',
};

async function serveStatic(env, request, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  if (!STATIC_TYPES[file]) return null; // not a known static file
  const embedded = EMBEDDED_FILES[file];
  if (embedded) {
    return new Response(embedded.body, {
      headers: { 'Content-Type': embedded.type, 'Cache-Control': 'public, max-age=3600' },
    });
  }
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request);
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
    'SELECT destination, enabled, expires_at FROM links WHERE alias = ?',
  ).bind(alias).first();
  if (!row) return new Response('ბმული არ მოიძებნა.', { status: 404 });
  if (row.enabled !== 1) return new Response('ბმული გამორთულია.', { status: 410 });
  if (row.expires_at !== null && row.expires_at <= now) {
    return new Response('ბმულის ვადა გავიდა.', { status: 410 });
  }

  // Count the click atomically (single UPDATE). Bot visits redirect but are
  // not counted. If counting fails, still redirect — availability first.
  if (!isBot(request.headers.get('User-Agent'))) {
    try {
      await env.DB.prepare(
        'UPDATE links SET clicks = clicks + 1 WHERE alias = ?',
      ).bind(alias).run();
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

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

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

  // Generic per-minute limit for authenticated API calls.
  const apiOk = await checkRateLimit(request, env, 'api', CONFIG.apiMaxPerMin, 60);
  if (!apiOk) return error('ძალიან ბევრი მოთხოვნა. სცადეთ ერთ წუთში.', 429);

  // --- List links ------------------------------------------------------
  if (path === '/api/links' && method === 'GET') {
    const search = (url.searchParams.get('search') || '').trim();
    let rows;
    if (search) {
      const like = '%' + search.replace(/[%_\\]/g, (c) => '\\' + c) + '%';
      rows = await env.DB.prepare(
        'SELECT id, alias, destination, created_at, expires_at, enabled, clicks ' +
        'FROM links WHERE alias LIKE ? ESCAPE \'\\\' OR destination LIKE ? ESCAPE \'\\\' ' +
        'ORDER BY created_at DESC LIMIT ?',
      ).bind(like, like, CONFIG.maxLinksList).all();
    } else {
      rows = await env.DB.prepare(
        'SELECT id, alias, destination, created_at, expires_at, enabled, clicks ' +
        'FROM links ORDER BY created_at DESC LIMIT ?',
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

    const ownHost = new URL(request.url).host;
    const v = validateDestination(destination, ownHost);
    if (!v.ok) return error(v.reason, 400);

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
          'INSERT INTO links (alias, destination, created_at, expires_at, enabled, clicks) ' +
          'VALUES (?, ?, ?, ?, 1, 0)',
        ).bind(finalAlias, v.url, Date.now(), expiresMs).run();
        if (!ins.success) return error('ბმულის შექმნა ვერ მოხერხდა.', 500);
      } catch (e) {
        if (String(e && e.message ? e.message : e).includes('UNIQUE')) {
          return error('ეს სახელი უკვე დაკავებულია.', 409);
        }
        throw e;
      }
    } else {
      // Auto-generate a 6-char alias; retry on (very unlikely) collision.
      let inserted = null;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const candidate = generateAlias();
        try {
          const ins = await env.DB.prepare(
            'INSERT INTO links (alias, destination, created_at, expires_at, enabled, clicks) ' +
            'VALUES (?, ?, ?, ?, 1, 0)',
          ).bind(candidate, v.url, Date.now(), expiresMs).run();
          if (ins.success) inserted = candidate;
        } catch (e) {
          if (!String(e && e.message ? e.message : e).includes('UNIQUE')) throw e;
        }
      }
      if (!inserted) return error('ბმულის შექმნა ვერ მოხერხდა — სცადეთ ხელახლა.', 500);
      finalAlias = inserted;
    }

    const row = await env.DB.prepare(
      'SELECT id, alias, destination, created_at, expires_at, enabled, clicks FROM links WHERE alias = ?',
    ).bind(finalAlias).first();
    return json({ link: linkRowToJson(request, row) }, 201);
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
      if (updates.length === 0) return error('შესაცვლელი არაფერია.', 400);
      values.push(id);
      const res = await env.DB.prepare(
        `UPDATE links SET ${updates.join(', ')} WHERE id = ?`,
      ).bind(...values).run();
      if (!res.success || (res.meta && res.meta.changes === 0)) {
        return error('ბმული არ მოიძებნა.', 404);
      }
      const row = await env.DB.prepare(
        'SELECT id, alias, destination, created_at, expires_at, enabled, clicks FROM links WHERE id = ?',
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
      'SELECT alias, destination, created_at, expires_at, enabled, clicks FROM links ORDER BY created_at ASC',
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
    const ownHost = new URL(request.url).host;
    let inserted = 0;
    let skipped = 0;
    let invalid = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') { invalid++; continue; }
      const v = validateDestination(item.destination, ownHost);
      if (!v.ok) { invalid++; continue; }
      const av = validateCustomAlias(item.alias || '');
      if (!av.ok) { invalid++; continue; }
      const createdAt = Number.isFinite(item.created_at) ? item.created_at : Date.now();
      const expiresMs = Number.isFinite(item.expires_at) ? item.expires_at : null;
      const enabled = item.enabled === 0 || item.enabled === false ? 0 : 1;
      const clicks = Number.isFinite(item.clicks) && item.clicks >= 0 ? Math.floor(item.clicks) : 0;
      try {
        const ins = await env.DB.prepare(
          'INSERT OR IGNORE INTO links (alias, destination, created_at, expires_at, enabled, clicks) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(av.alias, v.url, createdAt, expiresMs, enabled, clicks).run();
        if (ins.meta && ins.meta.changes === 1) inserted++;
        else skipped++;
      } catch {
        invalid++;
      }
    }
    return json({ inserted, skipped, invalid });
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
