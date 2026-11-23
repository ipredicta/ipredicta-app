// Consent decisions made in the members area are logged (TECH_DEBT #1, 23 Nov 2026): node --test tests/.
// The endpoint (netlify/lib/consent-log.mjs) with a fake Supabase, and public/assets/consent.js in a small fake DOM,
// so a click on the banner is followed through to the beacon it sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { ALLOWED_CATEGORIES, buildRow, consentLog } from '../netlify/lib/consent-log.mjs';

const ENV = { SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };
const NOW = new Date('2026-11-23T21:00:00.000Z');
const GOOD = {
  consent_id: 'c-123',
  policy_version: '2026-10-30.2',
  decided_at: '2026-11-23T20:59:58.000Z',
  retention_month: '1999-01',
  method: 'banner-accept',
  choices: { analytics: true, marketing: false, reviews: true, extra: true },
  page_path: '/?mode=signup#access_token=secret',
  ip: '1.2.3.4',
};

function harness({ status = 201, body = '', throws = false, env = ENV } = {}) {
  const calls = [];
  const errors = [];
  const handler = consentLog({
    env,
    now: () => NOW,
    log: { error: (...a) => errors.push(a.join(' ')) },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (throws) throw new Error('network down');
      return new Response(body, { status });
    },
  });
  return { handler, calls, errors };
}

function post(payload, headers = {}) {
  return new Request('https://app.ipredicta.co/.netlify/functions/consent-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('a decision is written to consent_records with the service key, shaped by the whitelist', async () => {
  const { handler, calls, errors } = harness();
  const res = await handler(post(GOOD, { Origin: 'https://app.ipredicta.co' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sb.example/rest/v1/consent_records');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer service-key');
  assert.equal(calls[0].init.headers.Prefer, 'return=minimal');
  const row = JSON.parse(calls[0].init.body);
  assert.deepEqual(row, {
    consent_id: 'c-123',
    policy_version: '2026-10-30.2',
    decided_at: '2026-11-23T20:59:58.000Z',
    retention_month: '2026-11', // recomputed, never the browser's
    method: 'banner-accept',
    choices: { analytics: true, marketing: false }, // reviews and unknown keys dropped, as on the site
    page_path: 'app.ipredicta.co/', // names this origin; no query, no fragment
  });
  assert.ok(!('ip' in row));
  assert.deepEqual(errors, []);
});

test('the whitelist matches the site endpoint (analytics, marketing since 18 Nov 2026)', () => {
  assert.deepEqual(ALLOWED_CATEGORIES, ['analytics', 'marketing']);
});

test('only a strict true counts as a yes', () => {
  const { row } = buildRow({ ...GOOD, choices: { analytics: 'true', marketing: 1 } }, NOW);
  assert.deepEqual(row.choices, { analytics: false, marketing: false });
});

test('a missing or bad client clock falls back to the server time', () => {
  const { row } = buildRow({ ...GOOD, decided_at: 'yesterday' }, NOW);
  assert.equal(row.decided_at, NOW.toISOString());
  assert.equal(row.retention_month, '2026-11');
});

test('a bad page_path is stored as the origin root', () => {
  assert.equal(buildRow({ ...GOOD, page_path: 'https://evil.example/x' }, NOW).row.page_path, 'app.ipredicta.co/');
  assert.equal(buildRow({ ...GOOD, page_path: null }, NOW).row.page_path, 'app.ipredicta.co/');
});

for (const [name, payload] of [
  ['no consent_id', { ...GOOD, consent_id: '' }],
  ['no policy_version', { ...GOOD, policy_version: undefined }],
  ['an unknown method', { ...GOOD, method: 'implied' }],
  ['a body that is not JSON', 'not json'],
  ['a body that is not an object', '42'],
]) {
  test(`${name}: nothing written, 204 to the browser, an error in the log`, async () => {
    const { handler, calls, errors } = harness();
    const res = await handler(post(payload));
    assert.equal(res.status, 204);
    assert.equal(calls.length, 0);
    assert.equal(errors.length, 1);
  });
}

test('a POST from another origin is dropped, not written', async () => {
  const { handler, calls, errors } = harness();
  for (const origin of ['https://evil.example', 'null']) {
    const res = await handler(post(GOOD, { Origin: origin }));
    assert.equal(res.status, 204);
  }
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 2);
});

test('a beacon with no Origin header is accepted, as on the site', async () => {
  const { handler, calls } = harness();
  await handler(post(GOOD));
  assert.equal(calls.length, 1);
});

test('not a POST: 405', async () => {
  const { handler, calls } = harness();
  const res = await handler(new Request('https://app.ipredicta.co/.netlify/functions/consent-log'));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(calls.length, 0);
});

test('missing Supabase settings: 204 and a loud log line, nothing attempted', async () => {
  const { handler, calls, errors } = harness({ env: {} });
  assert.equal((await handler(post(GOOD))).status, 204);
  assert.equal(calls.length, 0);
  assert.match(errors[0], /NOT persisted/);
});

test('a refused insert, a missing table and a network failure all answer 204 and say so in the log', async () => {
  for (const [opts, pattern] of [
    [{ status: 500, body: 'boom' }, /insert failed 500/],
    [{ status: 404, body: '{"code":"PGRST205"}' }, /does not exist/],
    [{ throws: true }, /insert threw/],
  ]) {
    const { handler, errors } = harness(opts);
    assert.equal((await handler(post(GOOD))).status, 204);
    assert.match(errors[0], pattern);
  }
});

// ── the browser side: a click on the banner sends the record to this origin's endpoint ─────────────────────────────

function fakeEl(tag) {
  const el = {
    tagName: tag,
    attrs: {},
    children: [],
    listeners: {},
    style: {},
    className: '',
    innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    removeEventListener() {},
    querySelector() { return fakeEl('div'); },
    querySelectorAll() { return []; },
    focus() {},
    closest() { return null; },
  };
  return el;
}

function loadConsent({ cookie = '' } = {}) {
  let jar = cookie;
  const beacons = [];
  const fetches = [];
  const body = fakeEl('body');
  const head = fakeEl('head');
  const document = {
    readyState: 'complete',
    body,
    head,
    activeElement: null,
    location: { href: 'https://app.ipredicta.co/' },
    createElement: fakeEl,
    addEventListener() {},
    removeEventListener() {},
    get cookie() { return jar; },
    set cookie(v) {
      const [pair] = v.split(';');
      const name = pair.split('=')[0];
      const kept = jar.split('; ').filter((c) => c && !c.startsWith(`${name}=`));
      if (!/max-age=0\b/i.test(v)) kept.push(pair);
      jar = kept.join('; ');
    },
  };
  const window = {
    location: { pathname: '/', hostname: 'app.ipredicta.co', protocol: 'https:', href: 'https://app.ipredicta.co/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: globalThis.crypto,
    dataLayer: [],
  };
  const navigator = {
    sendBeacon(url, blob) { beacons.push({ url, blob }); return true; },
  };
  const ctx = {
    window, document, navigator, Blob, JSON, Date, Math, Object, Array, String, encodeURIComponent, decodeURIComponent,
    crypto: globalThis.crypto, console,
    fetch: (url, init) => { fetches.push({ url, init }); return Promise.resolve(new Response(null, { status: 204 })); },
    setTimeout: () => 0, clearTimeout() {},
  };
  window.document = document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../public/assets/consent.js', import.meta.url), 'utf8'), ctx);
  return { window, body, beacons, fetches, jar: () => jar };
}

async function clickBanner(env, action) {
  const banner = env.body.children.find((c) => c.className === 'ipc-banner');
  assert.ok(banner, 'the banner is shown to a member with no record');
  const target = { closest: () => ({ getAttribute: () => action }) };
  for (const f of banner.listeners.click) f({ target });
  assert.equal(env.beacons.length, 1, 'one beacon per decision');
  return { url: env.beacons[0].url, rec: JSON.parse(await env.beacons[0].blob.text()) };
}

test('members area: Reject sends the decision to /.netlify/functions/consent-log on this origin', async () => {
  const env = loadConsent();
  const { url, rec } = await clickBanner(env, 'reject');
  assert.equal(url, '/.netlify/functions/consent-log');
  assert.equal(rec.method, 'banner-reject');
  assert.equal(rec.choices.analytics, false);
  assert.equal(rec.policy_version, env.window.iPredictaConsent.policyVersion);
  // The beaconed record is the one stored in the shared cookie.
  assert.equal(env.window.iPredictaConsent.getRecord().consent_id, rec.consent_id);
});

test('members area: Accept is logged too, and nothing is sent to ipredicta.co', async () => {
  const env = loadConsent();
  const { url, rec } = await clickBanner(env, 'accept');
  assert.equal(rec.method, 'banner-accept');
  assert.equal(rec.choices.analytics, true);
  assert.ok(!/^https?:/.test(url));
  assert.equal(env.fetches.length, 0);
});

test('the client file never points at the site endpoint (blocked at preflight, silently)', () => {
  const src = fs.readFileSync(new URL('../public/assets/consent.js', import.meta.url), 'utf8');
  assert.ok(!/ipredicta\.co\/\.netlify\/functions\/consent-log['"]/.test(src.replace(/\/\/.*$/gm, '')));
});
