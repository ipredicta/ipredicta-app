/* linking.mjs — venue account linking for members (Martin, 30 Oct 2026). Shared by the venue-link functions; lives in
 * netlify/lib because every file under netlify/functions is a public endpoint (see robots.js).
 *
 * WHAT MARTIN DECIDED (30 Oct 2026):
 *   - Polymarket by wallet address, READ-ONLY, and only where polymarket.com is allowed: never in the US or the UK. The
 *     rule is the site's polymarket-com-restricted.json, read the way its `_readme` says, failing closed.
 *   - Kalshi by the member's API key, READ-ONLY (a key with any write scope is refused), stored encrypted, after an
 *     explicit consent screen, for US readers only.
 *   - Other venues shown only once a venue offers read access to a member's account (none does today).
 * Both gates use the request's EDGE location (Netlify context.geo), the same signal the site's app-venue-links uses,
 * never anything the member says about themselves.
 *
 * WHY THIS IS NOT A REPEAT OF 8 OCT. Until 8 Oct 2026 (912746b) the members area stored a Kalshi key and a wallet and
 * nothing ever read them for a feature. This time every link shows the member something from the venue (positions
 * and value), or it is not offered.
 *
 * Storage (pr-agent migration, session 4): venue_links holds the PUBLIC side (the Polymarket address, the Kalshi key
 * id) and status; venue_secrets holds only the Kalshi private key's ciphertext. Both service_role only: a member's
 * client never reads either table; these functions answer for them, and never return a secret.
 */
import crypto from 'node:crypto';

export const SB_URL = 'https://xcjoclataeywhneruqrg.supabase.co';
export const RESTRICTIONS_URL = 'https://ipredicta.co/assets/data/polymarket-com-restricted.json';
export const POLY_DATA = 'https://data-api.polymarket.com';
export const KALSHI_BASE = 'https://api.elections.kalshi.com';
export const KALSHI_PREFIX = '/trade-api/v2';
const TIMEOUT_MS = 8000;

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

export async function timedFetch(url, init = {}, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** The member from the Bearer token, or a 401 Response. */
export async function memberFrom(req, sb) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { res: json(401, { error: 'Unauthorized' }) };
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return { res: json(401, { error: 'Invalid token' }) };
  return { user: data.user };
}

/** The edge location, in the shape the gates read. Unknown stays unknown. */
export function edgeGeo(context) {
  const cc = context?.geo?.country?.code;
  const sub = context?.geo?.subdivision?.code;
  return {
    country: typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null,
    subdivision: typeof sub === 'string' && sub.trim() ? sub.trim().toUpperCase() : null,
  };
}

// ── polymarket.com: the site's deny list, read as its _readme says, failing closed ───────────────────────────────────
const codes = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x && x.code)).filter((c) => typeof c === 'string').map((c) => c.toUpperCase()) : []);

export function parseRestrictions(j) {
  if (!j || typeof j !== 'object') return null;
  const alwaysExclude = j.alwaysExclude && typeof j.alwaysExclude === 'object' && !Array.isArray(j.alwaysExclude)
    ? Object.keys(j.alwaysExclude).map((k) => k.toUpperCase())
    : codes(j.alwaysExclude);
  const blocked = codes(j.blocked);
  if (!blocked.length && !alwaysExclude.length) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  return {
    alwaysExclude,
    blocked,
    subdivisionRequired: codes(j.subdivisionRequired),
    blockedSubdivisions: codes(j.blockedSubdivisions),
    reviewBy: typeof j.reviewBy === 'string' && day.test(j.reviewBy) ? j.reviewBy : null,
  };
}

/** Never in the US or the UK, whatever the file says; no file, an expired file or an unknown country: not allowed. */
export function polymarketAllowed(geo, r, now = new Date()) {
  const c = geo.country;
  if (c === 'US' || c === 'GB') return false;
  if (!r || !r.reviewBy || now.toISOString().slice(0, 10) > r.reviewBy) return false;
  if (!c) return false;
  if (r.alwaysExclude.includes(c) || r.blocked.includes(c)) return false;
  if (r.subdivisionRequired.includes(c)) {
    const sub = geo.subdivision;
    if (!sub) return false;
    const composed = sub.includes('-') ? sub : `${c}-${sub}`;
    if (r.blockedSubdivisions.includes(composed) || r.blockedSubdivisions.includes(sub)) return false;
  }
  return true;
}

export async function readRestrictions(fetchImpl = fetch) {
  const res = await timedFetch(RESTRICTIONS_URL, { headers: { Accept: 'application/json' } }, fetchImpl);
  if (!res || !res.ok) return null;
  try {
    return parseRestrictions(await res.json());
  } catch {
    return null;
  }
}

/** Kalshi linking: US readers only (Martin, 30 Oct 2026). */
export const kalshiAllowed = (geo) => geo.country === 'US';

// ── Polymarket: public data, keyed on the PROFILE (proxy) address ─────────────────────────────────────────────────────
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const maskAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Open positions, trimmed to what the member is shown. Null when Polymarket cannot be read. */
export async function polymarketPositions(address, fetchImpl = fetch) {
  const q = encodeURIComponent(address.toLowerCase());
  const [p, v] = await Promise.all([
    timedFetch(`${POLY_DATA}/positions?user=${q}&sizeThreshold=0.01&limit=100`, { headers: { Accept: 'application/json' } }, fetchImpl),
    timedFetch(`${POLY_DATA}/value?user=${q}`, { headers: { Accept: 'application/json' } }, fetchImpl),
  ]);
  if (!p || !p.ok) return null;
  let rows;
  try {
    rows = await p.json();
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  let total = null;
  if (v && v.ok) {
    try {
      const vj = await v.json();
      total = Array.isArray(vj) && vj[0] ? num(vj[0].value) : null;
    } catch {
      total = null;
    }
  }
  const positions = rows
    .map((r) => ({
      title: typeof r.title === 'string' ? r.title : null,
      outcome: typeof r.outcome === 'string' ? r.outcome : null,
      size: num(r.size),
      avgPrice: num(r.avgPrice),
      curPrice: num(r.curPrice),
      value: num(r.currentValue),
    }))
    .filter((r) => r.title && r.size !== null);
  return { positions, total, readAt: new Date().toISOString() };
}

// ── Kalshi: RSA-PSS signed requests with the member's READ-ONLY key ───────────────────────────────────────────────────
export const KEY_ID = /^[0-9a-fA-F-]{20,64}$/;

/** A PEM private key Node can load, or null. The text is never logged or echoed. */
export function loadPrivateKey(pem) {
  if (typeof pem !== 'string' || pem.length > 8000 || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) return null;
  try {
    const k = crypto.createPrivateKey({ key: pem.trim(), format: 'pem' });
    return k.asymmetricKeyType === 'rsa' ? k : null;
  } catch {
    return null;
  }
}

export function kalshiHeaders(keyId, key, method, path, now = Date.now()) {
  const ts = String(now);
  const sig = crypto.sign('sha256', Buffer.from(ts + method + path.split('?')[0]), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'), Accept: 'application/json' };
}

export async function kalshiGet(keyId, key, path, fetchImpl = fetch) {
  const full = KALSHI_PREFIX + path;
  const res = await timedFetch(KALSHI_BASE + full, { headers: kalshiHeaders(keyId, key, 'GET', full) }, fetchImpl);
  if (!res) return { status: 0, body: null };
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** READ-ONLY means: this key is listed, has scopes, and EVERY scope is `read` or a `read::` child. */
export function scopeVerdict(apiKeysBody, keyId) {
  const list = apiKeysBody && Array.isArray(apiKeysBody.api_keys) ? apiKeysBody.api_keys : null;
  if (!list) return 'unreadable';
  const mine = list.find((k) => k && k.api_key_id === keyId);
  if (!mine) return 'unreadable';
  const scopes = Array.isArray(mine.scopes) ? mine.scopes.filter((s) => typeof s === 'string') : [];
  if (!scopes.length) return 'unreadable';
  if (scopes.some((s) => s === 'write' || s.startsWith('write'))) return 'write';
  return scopes.every((s) => s === 'read' || s.startsWith('read::')) ? 'read' : 'unreadable';
}

/** Kalshi's Thursday maintenance, 09:00 to 11:00 Spain (session 4, 30 Oct 2026): no reads and no failure counting. */
export function inKalshiMaintenance(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const h = Number(parts.hour);
  return parts.weekday === 'Thu' && h >= 9 && h < 11;
}

/** 401 and 403 only count toward needs_relink (a bad or revoked key); 5xx and timeouts never do. */
export const countsAsRefusal = (status) => status === 401 || status === 403;
export const RELINK_AFTER = 3;

export function trimPortfolio(balanceBody, positionsBody) {
  const cents = balanceBody ? num(balanceBody.balance) : null;
  const rows = positionsBody && Array.isArray(positionsBody.market_positions) ? positionsBody.market_positions : [];
  const positions = rows
    .map((r) => ({ ticker: typeof r.ticker === 'string' ? r.ticker : null, position: num(r.position_fp ?? r.position), exposure: num(r.market_exposure_dollars ?? null) ?? (num(r.market_exposure) !== null ? num(r.market_exposure) / 100 : null) }))
    .filter((r) => r.ticker && r.position !== null && r.position !== 0);
  return { balance: cents === null ? null : cents / 100, positions, readAt: new Date().toISOString() };
}

// ── Encryption at rest: AES-256-GCM, versioned so the key can rotate ──────────────────────────────────────────────────
/* The keys are function environment variables only (KALSHI_LINK_ENC_KEY_V1, later _V2), 32 bytes as 64 hex characters,
 * set by session 4 from a 600 file through the Netlify API, never as a CLI argument and never in the repo or the
 * database. New ciphertext is written with the highest version present; each row is decrypted by its own prefix, so
 * a rotation is: add V2, re-encrypt the rows with a one-off job, then remove V1. */
function encKeys(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^KALSHI_LINK_ENC_KEY_V(\d+)$/.exec(k);
    if (m && typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) out[Number(m[1])] = Buffer.from(v, 'hex');
  }
  return out;
}

/** True when at least one valid versioned key is configured. Never reveals a value. */
export const encryptionReady = (env = process.env) => Object.keys(encKeys(env)).length > 0;

export function encrypt(plaintext, env = process.env) {
  const keys = encKeys(env);
  const versions = Object.keys(keys).map(Number);
  if (!versions.length) throw new Error('no encryption key configured');
  const ver = Math.max(...versions);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys[ver], iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v${ver}:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(ciphertext, env = process.env) {
  const m = /^v(\d+):([0-9a-f]{24}):([0-9a-f]{32}):([0-9a-f]+)$/.exec(ciphertext || '');
  if (!m) throw new Error('unrecognised ciphertext');
  const key = encKeys(env)[Number(m[1])];
  if (!key) throw new Error('no key for this version');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(m[2], 'hex'));
  d.setAuthTag(Buffer.from(m[3], 'hex'));
  return Buffer.concat([d.update(Buffer.from(m[4], 'hex')), d.final()]).toString('utf8');
}

export const keyHint = (keyId) => `…${keyId.slice(-4)}`;
