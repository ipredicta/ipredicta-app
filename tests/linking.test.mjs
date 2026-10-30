// Venue account linking (30 Oct 2026): node --test tests/. Outside netlify/functions on purpose (see robots.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { decrypt, encrypt, inKalshiMaintenance, polymarketAllowed, parseRestrictions, scopeVerdict } from '../netlify/lib/linking.mjs';
import {
  KALSHI_CONSENT_VERSION, kalshiLink, kalshiPortfolio, kalshiUnlink, polymarketLink, polymarketPositionsEndpoint, polymarketUnlink, venueLinkStatus,
} from '../netlify/lib/linking-handlers.mjs';

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_ID = '0b5e1c9a-1111-4222-8333-944455556666';
const ADDR = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const FILE = {
  reviewBy: '2099-01-01',
  alwaysExclude: { US: 'x', GB: 'x' },
  blocked: [{ code: 'AR' }, { code: 'FR' }],
  subdivisionRequired: ['CA'],
  blockedSubdivisions: [{ code: 'CA-ON' }],
};

// ── a tiny in-memory stand-in for the two tables, with the query shapes the handlers use ──
function fakeDb() {
  const rows = { venue_links: [], venue_secrets: [] };
  const q = (table) => {
    const f = {};
    let op = 'select';
    let patch = null;
    const api = {
      select: () => api,
      eq: (k, v) => ((f[k] = v), api),
      maybeSingle: async () => ({ data: rows[table].find((r) => Object.entries(f).every(([k, v]) => r[k] === v)) || null }),
      upsert: async (row) => {
        rows[table] = rows[table].filter((r) => !(r.user_id === row.user_id && r.venue === row.venue));
        rows[table].push({ ...row });
        return { error: null };
      },
      update: (p) => ((op = 'update'), (patch = p), api),
      delete: () => ((op = 'delete'), api),
      then: (res) => {
        const hit = (r) => Object.entries(f).every(([k, v]) => r[k] === v);
        if (op === 'update') rows[table].forEach((r) => hit(r) && Object.assign(r, patch));
        if (op === 'delete') rows[table] = rows[table].filter((r) => !hit(r));
        return res({ error: null });
      },
    };
    return api;
  };
  return { rows, client: { auth: { getUser: async (t) => (t === 'good' ? { data: { user: { id: 'u1' } }, error: null } : { data: { user: null }, error: 'bad' }) }, from: q } };
}

// ── the network: the site's file, Polymarket's data API, and a Kalshi that checks every signature ──
function fakeNet({ scopes = ['read'], kalshiStatus = 200, file = FILE } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://ipredicta.co/')) return file ? ok(file) : ok({}, 404);
    if (url.includes('data-api.polymarket.com/positions')) return ok([{ title: 'Will X win?', outcome: 'Yes', size: 10, avgPrice: 0.4, curPrice: 0.55, currentValue: 5.5 }]);
    if (url.includes('data-api.polymarket.com/value')) return ok([{ user: 'x', value: 5.5 }]);
    if (url.startsWith('https://api.elections.kalshi.com/trade-api/v2/')) {
      const h = init.headers;
      const path = new URL(url).pathname;
      const good = crypto.verify('sha256', Buffer.from(h['KALSHI-ACCESS-TIMESTAMP'] + 'GET' + path), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
      if (!good || h['KALSHI-ACCESS-KEY'] !== KEY_ID) return ok({ error: 'unauthorized' }, 401);
      if (kalshiStatus !== 200) return ok({}, kalshiStatus);
      if (path.endsWith('/api_keys')) return ok({ api_keys: [{ api_key_id: 'other', scopes: ['read', 'write'] }, { api_key_id: KEY_ID, name: 'ipredicta', scopes }] });
      if (path.endsWith('/portfolio/balance')) return ok({ balance: 12345 });
      if (path.endsWith('/portfolio/positions')) return ok({ market_positions: [{ ticker: 'KXFED-26DEC', position: 5, market_exposure: 250 }, { ticker: 'ZERO', position: 0 }] });
    }
    return ok({}, 404);
  };
  return { fetchImpl, calls };
}

const WED_NOON = new Date('2026-11-04T11:00:00Z'); // Wednesday 12:00 Spain
function deps(db, net, now = WED_NOON) {
  return { sb: () => db.client, fetch: net.fetchImpl, env: { KALSHI_LINK_ENC_KEY_V1: K1 }, now: () => now };
}
const call = async (h, { method = 'GET', body, token = 'good', country = 'FR', sub = null } = {}) => {
  const req = new Request('https://app.ipredicta.co/x', { method, headers: { authorization: token ? `Bearer ${token}` : '', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const res = await h(req, { geo: country ? { country: { code: country }, subdivision: sub ? { code: sub } : undefined } : {} });
  return { status: res.status, body: await res.json(), raw: res };
};
const kalshiBody = (o = {}) => ({ consent: KALSHI_CONSENT_VERSION, keyId: KEY_ID, privateKey: PEM, ...o });

test('every endpoint refuses without a valid session, and says noindex', async () => {
  const db = fakeDb();
  for (const h of [venueLinkStatus, polymarketPositionsEndpoint]) {
    const r = await call(h(deps(db, fakeNet())), { token: null });
    assert.equal(r.status, 401);
    assert.equal(r.raw.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await call(h(deps(db, fakeNet())), { token: 'bad' })).status, 401);
  }
});

test('polymarket.com gate: never US or UK, the file\'s lists, subdivisions, and closed on no file, expiry or unknown country', () => {
  const r = parseRestrictions(FILE);
  const now = new Date('2026-10-30T10:00:00Z');
  assert.equal(polymarketAllowed({ country: 'DE' }, r, now), true);
  for (const c of ['US', 'GB', 'AR', 'FR']) assert.equal(polymarketAllowed({ country: c }, r, now), false, c);
  assert.equal(polymarketAllowed({ country: 'CA', subdivision: 'ON' }, r, now), false);
  assert.equal(polymarketAllowed({ country: 'CA', subdivision: 'NS' }, r, now), true);
  assert.equal(polymarketAllowed({ country: 'CA', subdivision: null }, r, now), false);
  assert.equal(polymarketAllowed({ country: null }, r, now), false);
  assert.equal(polymarketAllowed({ country: 'DE' }, null, now), false);
  assert.equal(polymarketAllowed({ country: 'DE' }, { ...r, reviewBy: '2026-10-29' }, now), false);
  // Even a file that forgot them cannot open the US or the UK.
  const forgot = { ...r, alwaysExclude: [], blocked: ['ZZ'] };
  assert.equal(polymarketAllowed({ country: 'DE' }, forgot, now), true);
  for (const c of ['US', 'GB']) assert.equal(polymarketAllowed({ country: c }, forgot, now), false, c);
});

test('Polymarket: refused in the US, the UK and a blocked country; linked elsewhere with the address stored lowercase and shown masked', async () => {
  const db = fakeDb();
  for (const country of ['US', 'GB', 'FR', null]) assert.equal((await call(polymarketLink(deps(db, fakeNet())), { method: 'POST', body: { address: ADDR }, country })).status, 403, String(country));
  assert.equal((await call(polymarketLink(deps(db, fakeNet({ file: null }))), { method: 'POST', body: { address: ADDR }, country: 'DE' })).status, 403);
  assert.equal(db.rows.venue_links.length, 0);
  assert.equal((await call(polymarketLink(deps(db, fakeNet())), { method: 'POST', body: { address: '0x123' }, country: 'DE' })).status, 400);
  const r = await call(polymarketLink(deps(db, fakeNet())), { method: 'POST', body: { address: ADDR }, country: 'DE' });
  assert.equal(r.status, 200);
  assert.equal(r.body.address, '0xabcd…ef01');
  assert.equal(r.body.positions[0].title, 'Will X win?');
  assert.equal(r.body.total, 5.5);
  assert.equal(db.rows.venue_links[0].public_ref, ADDR.toLowerCase());
  // Positions: gated the same way, and at most one read per 30 s.
  assert.equal((await call(polymarketPositionsEndpoint(deps(db, fakeNet())), { country: 'GB' })).status, 403);
  assert.equal((await call(polymarketPositionsEndpoint(deps(db, fakeNet())), { country: 'DE' })).status, 429);
  assert.equal((await call(polymarketPositionsEndpoint(deps(db, fakeNet(), new Date(WED_NOON.getTime() + 31_000))), { country: 'DE' })).status, 200);
  // Unlink works from anywhere, so a member who moved can still remove it.
  assert.equal((await call(polymarketUnlink(deps(db, fakeNet())), { method: 'POST', country: 'US' })).status, 200);
  assert.equal(db.rows.venue_links.length, 0);
});

test('Kalshi scopes: read only is accepted; any write, a missing key or no scopes is refused', () => {
  const b = (scopes) => ({ api_keys: [{ api_key_id: 'k', scopes }] });
  assert.equal(scopeVerdict(b(['read']), 'k'), 'read');
  assert.equal(scopeVerdict(b(['read', 'read::portfolio_balance']), 'k'), 'read');
  assert.equal(scopeVerdict(b(['read', 'write']), 'k'), 'write');
  assert.equal(scopeVerdict(b(['read', 'write::trade']), 'k'), 'write');
  assert.equal(scopeVerdict(b(['write::transfer']), 'k'), 'write');
  assert.equal(scopeVerdict(b([]), 'k'), 'unreadable');
  assert.equal(scopeVerdict(b(undefined), 'k'), 'unreadable');
  assert.equal(scopeVerdict(b(['read']), 'other'), 'unreadable');
  assert.equal(scopeVerdict({}, 'k'), 'unreadable');
  assert.equal(scopeVerdict(b(['read', 'admin']), 'k'), 'unreadable');
});

test('Kalshi link: US only, consent required, trading keys refused and nothing stored; a read-only key stored encrypted', async () => {
  const db = fakeDb();
  assert.equal((await call(kalshiLink(deps(db, fakeNet())), { method: 'POST', body: kalshiBody(), country: 'GB' })).status, 403);
  assert.equal((await call(kalshiLink(deps(db, fakeNet())), { method: 'POST', body: kalshiBody({ consent: true }), country: 'US' })).status, 400);
  assert.equal((await call(kalshiLink(deps(db, fakeNet())), { method: 'POST', body: kalshiBody({ privateKey: 'nope' }), country: 'US' })).status, 400);
  const w = await call(kalshiLink(deps(db, fakeNet({ scopes: ['read', 'write'] }))), { method: 'POST', body: kalshiBody(), country: 'US' });
  assert.equal(w.status, 400);
  assert.equal(w.body.refused, 'write');
  assert.equal((await call(kalshiLink(deps(db, fakeNet({ scopes: [] }))), { method: 'POST', body: kalshiBody(), country: 'US' })).body.refused, 'unconfirmed');
  assert.equal(db.rows.venue_secrets.length + db.rows.venue_links.length, 0);

  const r = await call(kalshiLink(deps(db, fakeNet())), { method: 'POST', body: kalshiBody(), country: 'US' });
  assert.equal(r.status, 200);
  assert.equal(r.body.key, '…6666');
  assert.equal(r.body.balance, 123.45);
  assert.deepEqual(r.body.positions.map((p) => p.ticker), ['KXFED-26DEC']);
  assert.ok(!JSON.stringify(r.body).includes('PRIVATE'));
  const sec = db.rows.venue_secrets[0];
  assert.ok(sec.ciphertext.startsWith('v1:') && !sec.ciphertext.includes('PRIVATE'));
  assert.equal(decrypt(sec.ciphertext, { KALSHI_LINK_ENC_KEY_V1: K1 }), PEM.trim());
  assert.equal(sec.consent_version, KALSHI_CONSENT_VERSION);

  const s = await call(venueLinkStatus(deps(db, fakeNet())), { country: 'US' });
  assert.deepEqual(s.body.kalshi, { allowed: true, linked: true, key: '…6666', status: 'ok' });
  assert.equal(s.body.polymarket.allowed, false);
  assert.ok(!JSON.stringify(s.body).includes(sec.ciphertext.slice(0, 20)));
});

test('Kalshi reads: three 401/403s mean Reconnect; a 5xx never counts; nothing is read in the Thursday maintenance', async () => {
  const db = fakeDb();
  await call(kalshiLink(deps(db, fakeNet())), { method: 'POST', body: kalshiBody(), country: 'US' });
  let t = WED_NOON.getTime();
  const read = (net) => call(kalshiPortfolio(deps(db, net, new Date((t += 31_000)))), { country: 'US' });
  assert.equal((await read(fakeNet())).status, 200);
  assert.equal((await read(fakeNet({ kalshiStatus: 500 }))).status, 502);
  assert.equal(db.rows.venue_links[0].fail_count, 0);
  assert.equal((await read(fakeNet({ kalshiStatus: 401 }))).status, 502);
  assert.equal((await read(fakeNet({ kalshiStatus: 403 }))).status, 502);
  const third = await read(fakeNet({ kalshiStatus: 401 }));
  assert.equal(third.status, 409);
  assert.equal(db.rows.venue_links[0].status, 'needs_relink');
  // Stops reading once it needs a relink.
  const net = fakeNet();
  assert.equal((await read(net)).status, 409);
  assert.equal(net.calls.filter((u) => u.includes('kalshi.com')).length, 0);

  // Thursday 10:00 Spain: no Kalshi request at all.
  const db2 = fakeDb();
  await call(kalshiLink(deps(db2, fakeNet())), { method: 'POST', body: kalshiBody(), country: 'US' });
  const thu = new Date('2026-11-05T09:00:00Z');
  assert.equal(inKalshiMaintenance(thu), true);
  assert.equal(inKalshiMaintenance(new Date('2026-11-05T10:00:00Z')), false);
  const n2 = fakeNet();
  assert.equal((await call(kalshiPortfolio(deps(db2, n2, thu)), { country: 'US' })).status, 503);
  assert.equal(n2.calls.filter((u) => u.includes('kalshi.com')).length, 0);

  // Unlink removes the secret and the link, from anywhere.
  assert.equal((await call(kalshiUnlink(deps(db2, fakeNet())), { method: 'POST', country: 'ES' })).status, 200);
  assert.equal(db2.rows.venue_secrets.length + db2.rows.venue_links.length, 0);
});

test('encryption: versioned, tamper-evident, and rotatable', () => {
  const c1 = encrypt('secret', { KALSHI_LINK_ENC_KEY_V1: K1 });
  assert.match(c1, /^v1:/);
  const both = { KALSHI_LINK_ENC_KEY_V1: K1, KALSHI_LINK_ENC_KEY_V2: K2 };
  const c2 = encrypt('secret', both);
  assert.match(c2, /^v2:/);
  assert.equal(decrypt(c1, both), 'secret');
  assert.equal(decrypt(c2, both), 'secret');
  assert.throws(() => decrypt(c2, { KALSHI_LINK_ENC_KEY_V1: K1 }));
  const flipped = c1.slice(0, -1) + (c1.endsWith('0') ? '1' : '0');
  assert.throws(() => decrypt(flipped, { KALSHI_LINK_ENC_KEY_V1: K1 }));
  assert.throws(() => encrypt('x', {}));
});
