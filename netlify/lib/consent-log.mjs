/* consent-log.mjs — the members area's writer for public.consent_records (TECH_DEBT #1, 23 Nov 2026).
 *
 * Until this existed, a decision made in the members area was stored in the shared cookie and honoured, but never
 * recorded: the site's own /.netlify/functions/consent-log is same-origin-only, so this origin had nothing to call.
 * consent_records is our UK GDPR Article 7(1) evidence, so that was a hole in the record for every member who
 * answered here.
 *
 * COPIED FROM THE SITE'S FUNCTION, NOT REINVENTED (ipredicta-site netlify/functions/consent-log.js, origin/main
 * f48e62e74). The same table, the same whitelist, the same row shape, and the same rule that every failure path
 * answers 204 and logs loudly: the member's choice is in their cookie and is honoured whatever happens here, and a
 * privacy control must not surface an error. What differs, and why:
 *
 *   1. page_path NAMES THIS ORIGIN. The site stores a bare pathname, and the members area is one URL ("/"), so a
 *      row from here would read exactly like a decision on the site's home page. It is stored as
 *      "app.ipredicta.co/" instead, built here from a fixed prefix, never from the payload or the Host header.
 *   2. A CROSS-ORIGIN POST IS DROPPED. The site's endpoint relies on the browser's preflight alone; a plain form
 *      POST from another site would still reach it. Here a request whose Origin header names another host is
 *      dropped (still 204, still logged), so the evidence table cannot be filled from elsewhere. A request with no
 *      Origin (sendBeacon on some browsers) is accepted, as on the site.
 *   3. X-Robots-Tag on every response, like every function in this repo (see robots.js).
 *
 * No IP address, no user-agent, no member id and no email are stored, although all of them are available on this
 * origin: collecting identifying data to prove a privacy choice is self-defeating. See migration 029 in pr-agent.
 *
 * KEEP ALLOWED_CATEGORIES IN STEP WITH THE SITE'S (analytics, marketing since Trustpilot went on 18 Nov 2026). The
 * members area's record still carries a `reviews` key; it is dropped here exactly as the site drops it.
 */

export const TABLE = 'consent_records';
export const ALLOWED_CATEGORIES = ['analytics', 'marketing'];
export const ALLOWED_METHODS = ['banner-accept', 'banner-reject', 'settings-save'];
export const PATH_PREFIX = 'app.ipredicta.co';

function ack() {
  // 204 with no body: the client is sendBeacon() most of the time and cannot read a response anyway.
  return new Response(null, { status: 204, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
}

function isIsoDate(s) {
  return typeof s === 'string' && s.length >= 20 && !Number.isNaN(Date.parse(s));
}

function crossOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin || origin === 'null') return origin === 'null';
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

// The pathname alone, without a query or a fragment (Supabase puts tokens in the fragment), behind the fixed prefix.
function pagePath(given) {
  if (typeof given !== 'string' || !given.startsWith('/')) return `${PATH_PREFIX}/`;
  const path = given.split(/[?#]/)[0].slice(0, 256);
  return PATH_PREFIX + path;
}

// The row is built from the whitelist, never from the payload wholesale: this endpoint is public.
export function buildRow(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object') return { error: 'body was not an object' };
  const consentId = typeof payload.consent_id === 'string' ? payload.consent_id.slice(0, 64) : '';
  const policyVersion = typeof payload.policy_version === 'string' ? payload.policy_version.slice(0, 32) : '';
  const method = ALLOWED_METHODS.includes(payload.method) ? payload.method : null;
  if (!consentId || !policyVersion || !method) {
    return { error: 'missing consent_id, policy_version or valid method', detail: { has_consent_id: !!consentId, has_policy_version: !!policyVersion, method: payload.method } };
  }
  // A client clock can be wrong or absent: fall back to now rather than drop the record. received_at is set by the
  // table, so the two can disagree visibly.
  const decidedAt = isIsoDate(payload.decided_at) ? payload.decided_at : now.toISOString();
  const given = payload.choices && typeof payload.choices === 'object' ? payload.choices : {};
  const choices = {};
  for (const key of ALLOWED_CATEGORIES) choices[key] = given[key] === true;
  return {
    row: {
      consent_id: consentId,
      policy_version: policyVersion,
      decided_at: decidedAt,
      // Recomputed, so the retention cohort cannot be set by the browser.
      retention_month: decidedAt.slice(0, 7),
      method,
      choices,
      page_path: pagePath(payload.page_path),
    },
  };
}

export function consentLog(deps) {
  const log = deps.log || console;
  return async (req) => {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
    }
    if (crossOrigin(req)) {
      log.error(`consent-log: cross-origin POST from ${String(req.headers.get('origin')).slice(0, 100)} dropped`);
      return ack();
    }
    const url = deps.env.SUPABASE_URL;
    const key = deps.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      log.error('consent-log: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. The consent record was NOT persisted. The member\'s choice is unaffected.');
      return ack();
    }
    let payload;
    try {
      payload = JSON.parse(await req.text());
    } catch (e) {
      log.error('consent-log: unparseable body, record dropped:', e.message);
      return ack();
    }
    const built = buildRow(payload, deps.now ? deps.now() : new Date());
    if (built.error) {
      log.error(`consent-log: ${built.error}; record dropped`, built.detail || '');
      return ack();
    }
    try {
      const res = await deps.fetch(`${url}/rest/v1/${TABLE}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(built.row),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '<unreadable>');
        // PGRST205 is "table not found in schema cache". Named so the log says what to do, not just what broke.
        if (res.status === 404 || detail.includes('PGRST205')) {
          log.error(`consent-log: table public.${TABLE} does not exist (pr-agent migration 029). Consent records are NOT being persisted. Detail: ${detail.slice(0, 300)}`);
        } else {
          log.error(`consent-log: insert failed ${res.status}: ${detail.slice(0, 300)}`);
        }
      }
    } catch (err) {
      log.error('consent-log: insert threw, record dropped:', err.message);
    }
    return ack();
  };
}

export function realDeps() {
  return { fetch: (u, i) => fetch(u, i), env: process.env, now: () => new Date(), log: console };
}
