/* linking-handlers.mjs — the venue-link endpoints, built from their dependencies so tests run them with a fake database
 * and a fake network (tests/linking.test.mjs). Each netlify/functions/<name>.mjs is one line that wires the real ones.
 * Rules and storage: see linking.mjs.
 *
 * What a member's client can learn: whether each venue may be linked HERE (the edge gate), whether it is linked, the
 * masked Polymarket address or the Kalshi key's last four characters, the status, and the venue's own read of their
 * positions. Never the private key, never its ciphertext, and nothing about any other member.
 */
import { createClient } from '@supabase/supabase-js';
import {
  ADDRESS, KEY_ID, RELINK_AFTER, SB_URL, countsAsRefusal, decrypt, edgeGeo, encrypt, inKalshiMaintenance, json,
  kalshiAllowed, kalshiGet, keyHint, loadPrivateKey, maskAddress, memberFrom, polymarketAllowed, polymarketPositions,
  readRestrictions, scopeVerdict, trimPortfolio,
} from './linking.mjs';

export const MIN_READ_GAP_MS = 30_000;

export function realDeps() {
  return {
    sb: () => createClient(SB_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }),
    fetch: (u, i) => fetch(u, i),
    env: process.env,
    now: () => new Date(),
  };
}

const NOT_HERE = { polymarket: 'Polymarket accounts cannot be linked from your location.', kalshi: 'Kalshi accounts can be linked from the US only.' };

async function readBody(req) {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

async function linkRow(sb, userId, venue) {
  const { data } = await sb.from('venue_links').select('public_ref, linked_at, last_read_at, status, fail_count').eq('user_id', userId).eq('venue', venue).maybeSingle();
  return data || null;
}

function wrap(method, deps, body) {
  return async (req, context) => {
    if (req.method !== method) return json(405, { error: 'Method Not Allowed' });
    const sb = deps.sb();
    const m = await memberFrom(req, sb);
    if (m.res) return m.res;
    try {
      return await body({ req, context, sb, user: m.user, geo: edgeGeo(context) });
    } catch {
      // Never echo an error: one could carry a key or a ciphertext.
      return json(500, { error: 'Something went wrong. Try again.' });
    }
  };
}

// ── status ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function venueLinkStatus(deps) {
  return wrap('GET', deps, async ({ sb, user, geo }) => {
    const [poly, kal, restrictions] = await Promise.all([linkRow(sb, user.id, 'polymarket'), linkRow(sb, user.id, 'kalshi'), readRestrictions(deps.fetch)]);
    return json(200, {
      polymarket: {
        allowed: polymarketAllowed(geo, restrictions, deps.now()),
        linked: !!poly,
        address: poly ? maskAddress(poly.public_ref) : null,
        status: poly ? poly.status || 'ok' : null,
      },
      kalshi: {
        allowed: kalshiAllowed(geo),
        linked: !!kal,
        key: kal ? keyHint(kal.public_ref) : null,
        status: kal ? kal.status || 'ok' : null,
      },
    });
  });
}

// ── Polymarket ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function polymarketLink(deps) {
  return wrap('POST', deps, async ({ req, sb, user, geo }) => {
    if (!polymarketAllowed(geo, await readRestrictions(deps.fetch), deps.now())) return json(403, { error: NOT_HERE.polymarket });
    const { address } = await readBody(req);
    if (typeof address !== 'string' || !ADDRESS.test(address.trim())) return json(400, { error: 'That is not a Polymarket wallet address. It starts with 0x and has 40 more characters.' });
    const a = address.trim().toLowerCase();
    const read = await polymarketPositions(a, deps.fetch);
    if (!read) return json(502, { error: "We couldn't reach Polymarket just now. Try again in a minute." });
    const at = deps.now().toISOString();
    const { error } = await sb.from('venue_links').upsert({ user_id: user.id, venue: 'polymarket', public_ref: a, linked_at: at, last_read_at: at, status: 'ok', fail_count: 0, last_error: null }, { onConflict: 'user_id,venue' });
    if (error) return json(500, { error: 'Something went wrong. Try again.' });
    return json(200, { linked: true, address: maskAddress(a), ...read, empty: read.positions.length === 0 });
  });
}

export function polymarketPositionsEndpoint(deps) {
  return wrap('GET', deps, async ({ sb, user, geo }) => {
    if (!polymarketAllowed(geo, await readRestrictions(deps.fetch), deps.now())) return json(403, { error: NOT_HERE.polymarket });
    const row = await linkRow(sb, user.id, 'polymarket');
    if (!row) return json(404, { error: 'No Polymarket account is linked.' });
    const now = deps.now();
    if (row.last_read_at && now - new Date(row.last_read_at) < MIN_READ_GAP_MS) return json(429, { error: 'Read a moment ago.', retryAfterMs: MIN_READ_GAP_MS - (now - new Date(row.last_read_at)) });
    const read = await polymarketPositions(row.public_ref, deps.fetch);
    if (!read) return json(502, { error: "We couldn't reach Polymarket just now. Try again in a minute." });
    await sb.from('venue_links').update({ last_read_at: now.toISOString() }).eq('user_id', user.id).eq('venue', 'polymarket');
    return json(200, { address: maskAddress(row.public_ref), ...read, empty: read.positions.length === 0 });
  });
}

/** Unlinking is allowed from anywhere: a member who moved must still be able to remove what we hold. */
export function polymarketUnlink(deps) {
  return wrap('POST', deps, async ({ sb, user }) => {
    await sb.from('venue_links').delete().eq('user_id', user.id).eq('venue', 'polymarket');
    return json(200, { ok: true });
  });
}

// ── Kalshi ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const KALSHI_CONSENT_VERSION = 'kalshi-readonly-2026-10-30';

export function kalshiLink(deps) {
  return wrap('POST', deps, async ({ req, sb, user, geo }) => {
    if (!kalshiAllowed(geo)) return json(403, { error: NOT_HERE.kalshi });
    const b = await readBody(req);
    if (b.consent !== KALSHI_CONSENT_VERSION) return json(400, { error: 'Please read and accept what we store before linking.' });
    const keyId = typeof b.keyId === 'string' ? b.keyId.trim() : '';
    if (!KEY_ID.test(keyId)) return json(400, { error: 'That is not a Kalshi API key ID.' });
    const key = loadPrivateKey(b.privateKey);
    if (!key) return json(400, { error: 'That is not a Kalshi private key. Paste the whole key, including the BEGIN and END lines.' });
    if (inKalshiMaintenance(deps.now())) return json(503, { error: 'Kalshi is in its weekly maintenance until 11:00 Spain time. Try again after that.' });

    const keys = await kalshiGet(keyId, key, '/api_keys', deps.fetch);
    if (countsAsRefusal(keys.status)) return json(400, { error: "Kalshi didn't accept this key. Check the key ID and private key, and that the key hasn't been deleted." });
    if (keys.status !== 200) return json(502, { error: "We couldn't reach Kalshi just now. Try again in a minute." });
    const verdict = scopeVerdict(keys.body, keyId);
    if (verdict === 'write') return json(400, { error: 'This key can trade or move money, so we will not store it. Create a key with read access only and paste that one.', refused: 'write' });
    if (verdict !== 'read') return json(400, { error: "Kalshi didn't tell us this key is read-only, so we will not store it.", refused: 'unconfirmed' });

    const [bal, pos] = await Promise.all([kalshiGet(keyId, key, '/portfolio/balance', deps.fetch), kalshiGet(keyId, key, '/portfolio/positions?count_filter=position&limit=100', deps.fetch)]);
    if (bal.status !== 200) return json(502, { error: "Kalshi accepted the key but we couldn't read your balance. Try again in a minute." });

    const at = deps.now().toISOString();
    const ciphertext = encrypt(b.privateKey.trim(), deps.env);
    const s = await sb.from('venue_secrets').upsert({ user_id: user.id, venue: 'kalshi', key_id: keyId, ciphertext, created_at: at, consent_version: KALSHI_CONSENT_VERSION }, { onConflict: 'user_id,venue' });
    if (s.error) return json(500, { error: 'Something went wrong. Try again.' });
    const l = await sb.from('venue_links').upsert({ user_id: user.id, venue: 'kalshi', public_ref: keyId, linked_at: at, last_read_at: at, status: 'ok', fail_count: 0, last_error: null }, { onConflict: 'user_id,venue' });
    if (l.error) {
      await sb.from('venue_secrets').delete().eq('user_id', user.id).eq('venue', 'kalshi');
      return json(500, { error: 'Something went wrong. Try again.' });
    }
    return json(200, { linked: true, key: keyHint(keyId), ...trimPortfolio(bal.body, pos.status === 200 ? pos.body : null) });
  });
}

export function kalshiPortfolio(deps) {
  return wrap('GET', deps, async ({ sb, user, geo }) => {
    if (!kalshiAllowed(geo)) return json(403, { error: NOT_HERE.kalshi });
    const row = await linkRow(sb, user.id, 'kalshi');
    if (!row) return json(404, { error: 'No Kalshi account is linked.' });
    if (row.status === 'needs_relink') return json(409, { error: 'Kalshi stopped accepting your key. Link it again.', status: 'needs_relink' });
    const now = deps.now();
    if (inKalshiMaintenance(now)) return json(503, { error: 'Kalshi is in its weekly maintenance until 11:00 Spain time.', maintenance: true });
    if (row.last_read_at && now - new Date(row.last_read_at) < MIN_READ_GAP_MS) return json(429, { error: 'Read a moment ago.', retryAfterMs: MIN_READ_GAP_MS - (now - new Date(row.last_read_at)) });
    const { data: sec } = await sb.from('venue_secrets').select('key_id, ciphertext').eq('user_id', user.id).eq('venue', 'kalshi').maybeSingle();
    if (!sec) return json(409, { error: 'Kalshi stopped accepting your key. Link it again.', status: 'needs_relink' });
    const key = loadPrivateKey(decrypt(sec.ciphertext, deps.env));
    if (!key) return json(500, { error: 'Something went wrong. Try again.' });
    const [bal, pos] = await Promise.all([kalshiGet(sec.key_id, key, '/portfolio/balance', deps.fetch), kalshiGet(sec.key_id, key, '/portfolio/positions?count_filter=position&limit=100', deps.fetch)]);
    if (countsAsRefusal(bal.status)) {
      const fails = (row.fail_count || 0) + 1;
      const status = fails >= RELINK_AFTER ? 'needs_relink' : 'ok';
      await sb.from('venue_links').update({ fail_count: fails, status, last_error: `kalshi ${bal.status}`, last_read_at: now.toISOString() }).eq('user_id', user.id).eq('venue', 'kalshi');
      return status === 'needs_relink'
        ? json(409, { error: 'Kalshi stopped accepting your key. Link it again.', status })
        : json(502, { error: "Kalshi didn't accept your key just now." });
    }
    if (bal.status !== 200) return json(502, { error: "We couldn't reach Kalshi just now. Try again in a minute." });
    await sb.from('venue_links').update({ fail_count: 0, status: 'ok', last_error: null, last_read_at: now.toISOString() }).eq('user_id', user.id).eq('venue', 'kalshi');
    return json(200, { key: keyHint(sec.key_id), ...trimPortfolio(bal.body, pos.status === 200 ? pos.body : null) });
  });
}

export function kalshiUnlink(deps) {
  return wrap('POST', deps, async ({ sb, user }) => {
    await sb.from('venue_secrets').delete().eq('user_id', user.id).eq('venue', 'kalshi');
    await sb.from('venue_links').delete().eq('user_id', user.id).eq('venue', 'kalshi');
    return json(200, { ok: true });
  });
}
