# TECH_DEBT — ipredicta-app (members area)

Operational defects: things that are wrong, fragile, or will bite someone. Strategy and
sequencing live in ROADMAP.md.

Opened 2026-09-19 with the consent and GA4 work. Items are numbered for reference, not
priority; the state line says what is actually true today.

---

## 1. A decision made in the members area is never logged

**State: open, and it is a compliance hole, not an inconvenience.**

The site POSTs every consent decision to its own `/.netlify/functions/consent-log`, which
writes a row to `public.consent_records` in Supabase. That row is how we demonstrate the
consent under UK GDPR Article 7(1).

This origin writes no such row. The site's endpoint sends **no CORS headers and has no
OPTIONS handler**, so a cross-origin POST from `app.ipredicta.co` is blocked by the browser
at preflight, for `fetch` and for `sendBeacon` with an `application/json` body alike. The
port therefore ships with no logging at all rather than with a call that always fails
silently, which would have read as working.

**The consequence, stated plainly:** a member who accepts or rejects in the members area has
their choice stored in the cookie and honoured on both origins, and we hold no record that
they made it. If they later made a subject access request, or the ICO asked, the decision
would be invisible to us.

**This is a gap on THIS origin only. The site's logging is working.** Migration 029 was
applied on 14 August 2026 and `public.consent_records` has been collecting rows ever since:
measured on 19 September 2026, **220 rows**, earliest `2026-08-15T09:21:55`, still arriving
that evening. So the hole is exactly the shape described above and no wider, and nobody
should read this item as "consent has never been recorded anywhere".

That count was read with the **service** key. An anon SELECT on this table returns `200 []`
rather than `401` and `Prefer: count=exact` does not separate the two, so any statement about
what this table holds has to name the key that read it.

The fix is an endpoint on this origin, and it has no prerequisite outside the code:
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already set on the `ipredicta-app` Netlify
site for the Kalshi and Telegram functions (checked 19 September 2026). See ROADMAP.md NOW.

## 2. POLICY_VERSION is hand-copied across two repositories with nothing comparing them

**State: open. The failure mode is silent and permanent.**

`public/assets/consent.js` declares `POLICY_VERSION = '2026-08-17.1'`. So does
`ipredicta 3/assets/js/consent.js` in ipredicta-site. Both read the same shared cookie and
both re-prompt when the record's version does not match their own.

Bump it on the site and not here and the two origins take turns: the site writes the new
version, this origin sees a version it does not recognise and re-prompts, writes the old
version back, the site sees a stale record and re-prompts. **A member is asked for ever, on
both properties, and nothing errors.** There is no CI in this repo and no check in either.

Cheapest real fix is to serve the constant from one place (the site already serves
`/assets/data/*.json` cross-origin for the app's venue gate, so the pattern exists). A
check that fetches the site's file and compares the literal would also do, and is a
half-hour of work.

## 3. No consent banner on `/reset/`

**State: open, low severity, recorded so it is not rediscovered as a surprise.**

`public/reset/index.html` is a separate page and does not load `consent.js`. Today that is
harmless and arguably correct: it loads no analytics, no GA4 and nothing else
non-essential, so there is nothing to consent to and a banner would be a control over
nothing.

It stops being harmless the moment anyone adds a tracker to that page, because the page has
no mechanism to gate one. If you add anything to `/reset/`, add `consent.js` first.

## 4. The sign-in screen is not reported to GA4

**State: open, by omission rather than by decision.**

`trackView()` covers the five members-area screens. The signed-out sign-in and sign-up
screens send no `page_view`, so GA4 sees a session that begins at `/app/home` with no
landing screen before it, and the sign-up funnel is invisible.

This was outside the brief's five-view map and is not being smuggled in. It is a small
change (`enterAuth()` and `showAuthForm()`) and is in ROADMAP.md NEXT because it is the
difference between "we have analytics" and "we can see whether sign-up works".

## 5. `index.html` is a single 2,400-line file with all markup, CSS and JS inline

**State: open, pre-existing, made slightly worse by this change.**

This work added roughly 40 lines to it and deliberately put the 600-line consent module in
`public/assets/consent.js` instead of inlining it, so the file grew by less than the feature
did. That is a mitigation, not a fix.

The cost is concrete and was paid during this work: there is no way to unit-test anything in
the inline block, so the consent module could be tested against a DOM shim and the view map
and `trackView()` could not. They were verified by reading.

## 6. No CI, no tests in the repository

**State: open. Directly relevant to items 1, 2 and 5.**

The consent module was verified by a throwaway Node harness written outside the repository
(61 assertions, including the category-preservation requirement driven through the real
click handlers, and confirmed to fail when the merge logic is deliberately broken). **That
harness was not committed and does not run anywhere.** The next person to touch
`buildRecord` has nothing to catch them.

`netlify.toml` has no build command, so there is no place a check could be wired even if one
were written. That is the thing to fix first: a `[build] command` that runs `node --check` on
the two scripts is five minutes and would have caught a syntax error shipping straight to
production.

## 7. A merge to main is live in seconds with nothing in between

**State: open, pre-existing, and it is the reason everything here is treated as production.**

`netlify.toml` declares `publish = "public"` and no build command. There is no CI, no
deploy-verify equivalent, no promotion step. A push to main that breaks `index.html` is a
broken members area for every signed-in user, immediately, and the first signal would be a
member complaining.

Note for anyone reading an older brief: this repo does **not** publish from the repository
root. It did until 2026-09-17, when `publish = "."` was found to be serving
`/package.json` and every file under `/netlify/functions/` as readable source. Anything a
browser must fetch goes in `public/`; anything else must stay out of it.
