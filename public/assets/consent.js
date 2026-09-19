/**
 * consent.js — the members area's consent mechanism and its only GA4 loader.
 *
 * PORTED FROM ipredicta-site, "ipredicta 3/assets/js/consent.js" (origin/main
 * eba5da734, blob 70213c082) on 2026-09-19. That file is the original; this one
 * is deliberately a sibling rather than a copy, and the differences are listed
 * under WHAT IS DIFFERENT HERE below. Read the site file's header for the
 * reasoning behind the parts that are identical: it is the longer document and
 * it explains why the tags are not loaded at all rather than loaded and muted.
 *
 * THE RECORD IS SHARED. The site moved its record from localStorage to a cookie
 * on .ipredicta.co on 2026-09-19 precisely so this origin could read it, so the
 * cookie name, the record shape, the category keys and POLICY_VERSION are not
 * ours to change. A member who answered on ipredicta.co is not asked again
 * here, and a member who answers here is not asked again there.
 *
 * THIS FILE IS THE ONLY THING THAT LOADS GA4 IN THE MEMBERS AREA. Putting a
 * gtag snippet into index.html would silently revert the control the privacy
 * policy describes. There is no Consent Mode here and that is deliberate: a
 * member who has not consented makes no request to googletagmanager.com at all,
 * which is observable in devtools and therefore checkable.
 *
 * WHAT IS DIFFERENT HERE, and why:
 *
 *   1. ONE VISIBLE CATEGORY. The banner and the panel offer Analytics only.
 *      impact.com is not on this origin and the Trustpilot widget is not either,
 *      so offering "Affiliate tracking" and "Reviews" here would be offering a
 *      control over nothing. Disabled toggles were rejected for the same reason.
 *      The RECORD still carries all three keys: see RECORD_CATEGORIES.
 *
 *   2. NO LOGGING. The site POSTs each decision to its own
 *      /.netlify/functions/consent-log. That endpoint sends no CORS headers and
 *      has no OPTIONS handler, so a cross-origin POST from this origin is
 *      blocked by the browser at preflight, for both fetch and sendBeacon with
 *      an application/json body. A call that can only ever fail is worse than no
 *      call, because it reads as working. A decision made here is stored and
 *      honoured but NOT logged, so the Article 7(1) demonstrability record has a
 *      hole in it for app-originated decisions. See ROADMAP.md (NOW) and
 *      TECH_DEBT.md.
 *
 *   3. send_page_view IS FALSE and page_location is synthetic. The members area
 *      is one URL with five screens, so GA4 is configured not to send its own
 *      page_view and this file sends one per screen instead. page_location is
 *      built from a fixed origin plus a mapped path rather than read from
 *      window.location, which is not a style choice: Supabase puts recovery and
 *      magic-link tokens in the URL fragment, and gtag's default page_location
 *      is document.location.href, fragment included. Constructing the value
 *      means a token cannot reach Google even if someone later lands on this
 *      origin with one in the URL.
 *
 *   4. STYLED FROM THE APP'S TOKENS. The site copies hex values because three of
 *      its pages do not load shared.css. Here there is one page and it defines
 *      :root custom properties, so this uses var() and a restyle of the app
 *      carries the banner with it. The values happen to be identical today.
 *
 * HOUSE RULES OBSERVED: no emoji (inline SVG only, if ever needed), and no
 * em-dashes or en-dashes in any member-facing string.
 */
(function () {
  'use strict';

  /* ── Policy version ────────────────────────────────────────────────────────
   * NOT OURS TO BUMP. It is the site's, it describes the policy document and
   * the vendor set as a whole, and the two origins compare it against the same
   * shared record. Bumping it here and not there would re-prompt every member
   * on one origin and not the other, and the two would then take turns deciding
   * the other's record was stale.
   *
   * IT IS ALSO NOT CHECKED ANYWHERE. This is a hand-copied constant in a second
   * repository with nothing comparing the two, which is the defect recorded in
   * TECH_DEBT.md. If the site bumps this and nobody bumps it here, the symptom
   * is not an error: it is members being asked twice, for ever.
   */
  var POLICY_VERSION = '2026-08-17.1';

  /* ── Vendor identifiers ──────────────────────────────────────────────────── */
  var GA_MEASUREMENT_ID = 'G-RMVT3V0874';

  // The origin page paths are reported against. FIXED, not read from the
  // browser: see point 3 in the header. Changing this to window.location.origin
  // reintroduces the fragment-token risk it exists to remove.
  var REPORTED_ORIGIN = 'https://app.ipredicta.co';

  // THE RECORD IS A COOKIE, not localStorage, so that this origin and
  // ipredicta.co read the same decision. Identical to the site's values and
  // must stay identical.
  var COOKIE_NAME = 'ipredicta.consent.v1';
  var COOKIE_DOMAIN = '.ipredicta.co';
  var COOKIE_MAX_AGE = 63072000;              // 730 days, about two years
  // The same name in localStorage, where records written by the pre-cookie
  // version of the site's file live. Read once, by the migration, then removed.
  var LEGACY_LS_KEY = 'ipredicta.consent.v1';

  var PRIVACY_URL = 'https://ipredicta.co/privacy/';

  /* ── Categories ────────────────────────────────────────────────────────────
   * TWO LISTS, DELIBERATELY, AND THEY DO DIFFERENT JOBS.
   *
   * RECORD_CATEGORIES is the shape of the shared record. All three keys are
   * written on every save, whatever this origin shows, because the record is
   * read by ipredicta.co and a key missing from it is not "unset", it is
   * `undefined`, which the site's applyChoices() reads as false. Saving here
   * would then silently switch off a member's affiliate-tracking choice made
   * there. `marketing` keeps its key even though the site labels it "Affiliate
   * tracking": the key is the wire format, the title is copy.
   *
   * APP_CATEGORIES is what a member is shown and asked about. One entry, because
   * there is exactly one non-essential vendor on this origin. Adding a second
   * means adding it to BOTH lists.
   */
  var RECORD_CATEGORIES = ['analytics', 'marketing', 'reviews'];

  var APP_CATEGORIES = [
    {
      key: 'analytics',
      vendors: ['Google LLC'],
      title: 'Analytics',
      body: 'Google Analytics, so we can count visits and see which screens are used. ' +
            'Sets two cookies on this domain that last about two years.'
    }
  ];

  /* Essential is not a category because it is not a choice. The members area
   * needs its sign-in cookies and the record of this decision to work at all;
   * both are described in the panel rather than offered as a toggle that cannot
   * be turned off. */

  // Every list of app-visible keys is derived, never enumerated a second time.
  // Adding `reviews` to the site on 2026-08-17 broke four hardcoded
  // {analytics, marketing} literals there; this avoids inheriting that shape.
  function allAppCategories(value) {
    var o = {};
    APP_CATEGORIES.forEach(function (c) { o[c.key] = value; });
    return o;
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  // Every access is guarded. Safari private browsing throws on localStorage and
  // a cookie write can be refused outright; a throw here would take the banner
  // down and leave the member with no control at all. If storage is unavailable
  // the decision cannot be remembered, so the banner returns next visit and
  // nothing non-essential ever loads. That degrades towards not tracking.

  // DOMAIN IS SET ONLY WHEN THE PAGE IS ACTUALLY SERVED FROM ipredicta.co. A
  // cookie whose Domain does not match the current host is rejected silently, so
  // hardcoding it would break localhost and every deploy preview: the write
  // would fail, readRecord would return null, and the banner would reappear on
  // every load with no way to dismiss it. On any other host the cookie is
  // host-only, which is correct there and shares nothing.
  function cookieDomainAttr() {
    try {
      var h = window.location.hostname || '';
      if (h === 'ipredicta.co' || h.slice(-13) === '.ipredicta.co') {
        return '; Domain=' + COOKIE_DOMAIN;
      }
    } catch (e) { /* fall through to a host-only cookie */ }
    return '';
  }

  // Secure on every https origin, omitted on plain http so local development
  // works. Never HttpOnly: this file reads the record in JavaScript.
  function cookieSecureAttr() {
    try {
      return window.location.protocol === 'https:' ? '; Secure' : '';
    } catch (e) {
      return '; Secure';
    }
  }

  function readRecord() {
    try {
      var all = String(document.cookie || '').split(';');
      for (var i = 0; i < all.length; i++) {
        var eq = all[i].indexOf('=');
        if (eq < 0) continue;
        if (all[i].slice(0, eq).trim() !== COOKIE_NAME) continue;
        var raw = decodeURIComponent(all[i].slice(eq + 1).trim());
        if (!raw) return null;
        var rec = JSON.parse(raw);
        if (!rec || typeof rec !== 'object') return null;
        return rec;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function writeRecord(rec) {
    try {
      document.cookie = COOKIE_NAME + '=' + encodeURIComponent(JSON.stringify(rec)) +
        cookieDomainAttr() +
        '; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax' +
        cookieSecureAttr();
      // A COOKIE WRITE REPORTS NOTHING. Assignment to document.cookie returns no
      // status and throws on nothing, so a refused write is indistinguishable
      // from a successful one until you read it back. It is read back here
      // because the migration deletes the old localStorage record on the
      // strength of this answer. decided_at is compared as well as consent_id,
      // because consent_id is carried forward across updates and would still
      // match a stale cookie that had not been replaced.
      var back = readRecord();
      return !!(back && back.consent_id === rec.consent_id &&
                back.decided_at === rec.decided_at);
    } catch (e) {
      return false;
    }
  }

  // ── Migration from localStorage ───────────────────────────────────────────
  // Carried over from the site unchanged, and it is not dead code here. The
  // members area has never written a consent record of any kind, but
  // localStorage is per origin and this origin's localStorage is not the site's,
  // so on app.ipredicta.co this can only find a record that THIS origin wrote.
  // It never has. The path is kept anyway for two reasons: the record format is
  // shared, so an old-format record is a thing this file must be able to read
  // wherever it appears; and if this module is ever served from ipredicta.co, a
  // member's pre-cookie record must still be honoured rather than re-prompted.
  // It costs one localStorage read on the first load with no cookie.
  //
  // SOMEONE WHO HAS ALREADY ANSWERED MUST NOT BE ASKED AGAIN, so the record is
  // copied across UNCHANGED: the same consent_id, decided_at, policy_version and
  // choices. It is not a fresh decision and policy_version is not bumped.
  // Nothing is re-logged, which here is trivially true because nothing is logged
  // at all.
  //
  // THE OLD RECORD IS DELETED, and only after the cookie write is verified.
  // Leaving it would make it a stale snapshot, so a member who later withdrew
  // consent and then cleared their cookies would be migrated straight back onto
  // the old accepting record. Resurrecting a withdrawn consent is worse than
  // asking once more, so the copy is one-way and the source is removed.
  //
  // If the cookie write is refused the old record is left where it is and still
  // returned, so the decision is honoured for this load and the member is not
  // re-prompted while cookies are unavailable.
  function migrateFromLocalStorage() {
    var raw = null;
    try {
      raw = window.localStorage.getItem(LEGACY_LS_KEY);
    } catch (e) {
      return null;
    }
    if (!raw) return null;
    var rec = null;
    try {
      rec = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!rec || typeof rec !== 'object' || !rec.choices) return null;
    if (!writeRecord(rec)) return rec;
    try {
      window.localStorage.removeItem(LEGACY_LS_KEY);
    } catch (e) { /* the copy is made; an undeletable source is not fatal */ }
    return rec;
  }

  function newConsentId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      if (window.crypto && window.crypto.getRandomValues) {
        var b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = [];
        for (var i = 0; i < b.length; i++) h.push((b[i] + 0x100).toString(16).slice(1));
        return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
               h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
               h.slice(10, 16).join('');
      }
    } catch (e) { /* fall through */ }
    return 'nid-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
  }

  // ── GA4 ───────────────────────────────────────────────────────────────────
  // Idempotent. A member can open the settings panel and save repeatedly, and
  // re-running gtag('config') would double-count.
  var analyticsLoaded = false;

  // The screen showing when consent arrives, so it can be reported once GA4 is
  // up. Without this, a member who accepts from the banner has their first
  // screen counted only when they navigate away from it, and the screen they
  // were actually on when they consented is never reported at all.
  var pendingView = null;

  function loadAnalytics() {
    if (analyticsLoaded) return;
    analyticsLoaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = window.gtag || gtag;
    window.gtag('js', new Date());
    // send_page_view:false because this is one URL with five screens. GA4's own
    // page_view would fire once, on the URL, and report every screen as "/".
    // The five are sent by pageView() below instead.
    window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });
    if (pendingView) {
      sendPageView(pendingView.path, pendingView.title);
      pendingView = null;
    }
  }

  // NO MEMBER IDENTIFIER REACHES THIS FUNCTION, and the paths it accepts are
  // from a fixed map in index.html, not from anything a member typed or from
  // window.location. The members area renders the signed-in email on two
  // screens; none of it is in a path, a title or a parameter. No user_id, no
  // user_properties, no email hash.
  function sendPageView(path, title) {
    if (!analyticsLoaded || typeof window.gtag !== 'function') return;
    window.gtag('event', 'page_view', {
      page_title: title,
      page_path: path,
      // Set explicitly rather than left to gtag, which would use
      // document.location.href and carry any recovery or magic-link token that
      // happened to be in the fragment. See point 3 in the file header.
      page_location: REPORTED_ORIGIN + path
    });
  }

  // Called by showView() in index.html on every screen change, and once by
  // enterApp() for the screen the app opens on. Safe to call before a decision
  // exists and safe to call after a rejection: it records the screen so a later
  // acceptance can report it, and sends nothing until GA4 is loaded.
  function pageView(path, title) {
    if (!path) return;
    if (!analyticsLoaded) { pendingView = { path: path, title: title }; return; }
    sendPageView(path, title);
  }

  function applyChoices(choices) {
    if (choices.analytics) loadAnalytics();
    // Nothing is unloaded on withdrawal. A script already executed cannot be
    // recalled, and pretending otherwise in code would be worse than saying so:
    // withdrawal stops future loads and takes effect fully on the next load. The
    // panel tells the member this in as many words.
    //
    // `marketing` and `reviews` are intentionally not read here. Neither vendor
    // is on this origin, so there is nothing for them to switch on, and a loader
    // for a vendor that is not here would be the thing that quietly puts it here.
  }

  // ── The consent record ────────────────────────────────────────────────────
  // WHAT IS DELIBERATELY NOT IN IT: no IP address, no user-agent, no referrer,
  // no fingerprint, and on this origin in particular no member id and no email,
  // even though this file runs on a page where a session exists. The record
  // exists to show that a decision was made and what it was, per UK GDPR
  // Article 7(1). consent_id is a random value with no meaning outside the
  // browser that holds it.
  //
  // CHOICES THIS ORIGIN DOES NOT ASK ABOUT ARE CARRIED FORWARD, NOT DEFAULTED.
  // This is the whole of requirement 2 and it is one line of logic with a large
  // consequence: without it, a member who accepted affiliate tracking on
  // ipredicta.co and then saved anything at all here would have that choice
  // silently switched off, because the site reads a missing key as false.
  //
  // When there is no existing record the unasked categories are written false.
  // That fails closed, which is the right direction, but it does mean a member
  // whose first decision is made here is never offered the site's other two
  // categories until they open Cookie settings on the site. Recorded in
  // ROADMAP.md rather than worked around, because working around it means
  // either changing the shared record shape or changing the site, and this brief
  // allows neither.
  function buildRecord(choices, method, existing) {
    var now = new Date();
    var prior = (existing && existing.choices) || {};
    return {
      consent_id: (existing && existing.consent_id) || newConsentId(),
      policy_version: POLICY_VERSION,
      decided_at: now.toISOString(),
      // Coarse retention key. Month granularity, not the timestamp, because the
      // retention job selects whole cohorts to expire. See the site's migration
      // 029 for the period and for why erasure is not automatic.
      retention_month: now.toISOString().slice(0, 7),
      method: method,               // 'banner-accept' | 'banner-reject' | 'settings-save'
      choices: (function () {
        var out = {};
        var asked = allAppCategories(false);
        RECORD_CATEGORIES.forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(asked, key)) {
            out[key] = !!choices[key];          // asked here, so this origin decides it
          } else {
            out[key] = !!prior[key];            // not asked here, so preserve it
          }
        });
        return out;
      })(),
      // The members area is a single URL, so this is always "/". Kept because
      // the field is part of the shared record and the site's consent-log reads
      // it. It carries no query string and no fragment by construction.
      page_path: (function () {
        try { return window.location.pathname; } catch (e) { return null; }
      })()
    };
  }

  // NO logRecord() HERE, AND THE ABSENCE IS THE POINT. See point 2 in the file
  // header: the site's endpoint is same-origin-only, so the honest options were
  // no call or a call that always fails. Do not "fix" this by pointing a fetch
  // at https://ipredicta.co/.netlify/functions/consent-log; it will be blocked
  // at preflight and the failure is silent. The fix is an endpoint on this
  // origin, which is a ROADMAP item and needs the service-role key and the
  // consent_records table.

  function decide(choices, method) {
    var existing = readRecord();
    var rec = buildRecord(choices, method, existing);
    writeRecord(rec);
    applyChoices(rec.choices);
    closeBanner();
    closePanel();
    return rec;
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // var() against the app's :root tokens, not copied hex. One page, one token
  // set, so a restyle of the app carries the banner with it.
  //
  // The app's reset sets `button { border: none; outline: none }` globally, so
  // every border and every focus ring below is stated explicitly. Removing the
  // :focus-visible rules would leave these controls with no visible focus at
  // all, which on a consent dialog is not a cosmetic loss.
  var CSS = [
    '.ipc-banner,.ipc-panel-card{font-family:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}',
    '.ipc-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:var(--surface);border-top:1.5px solid var(--border);box-shadow:0 -4px 24px rgba(13,27,62,.12);padding:18px 20px}',
    '.ipc-banner-inner{max-width:1080px;margin:0 auto;display:flex;gap:18px;align-items:center;flex-wrap:wrap}',
    '.ipc-banner-text{flex:1 1 340px;min-width:260px;font-size:.88rem;line-height:1.55;color:var(--text-mid)}',
    '.ipc-banner-text strong{display:block;font-family:"Syne",system-ui,sans-serif;font-size:1rem;color:var(--text);margin-bottom:4px}',
    '.ipc-banner-text a{color:var(--blue);text-decoration:underline}',
    '.ipc-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
    /* EQUAL VISUAL WEIGHT IS A COMPLIANCE REQUIREMENT, NOT A STYLE PREFERENCE.
       Accept and Reject share one class and therefore share padding, font size,
       font weight, radius and min-width. They differ in fill hue only, and the
       reject fill is a slate no less prominent than the blue. If someone later
       makes reject a text link or shrinks it, that is a regression. */
    '.ipc-btn{font:inherit;font-size:.86rem;font-weight:700;letter-spacing:.01em;padding:11px 20px;min-width:132px;border-radius:var(--radius-sm);border:2px solid transparent;cursor:pointer;text-align:center;line-height:1.2;transition:all var(--transition)}',
    '.ipc-btn-accept{background:var(--blue);color:var(--white);border-color:var(--blue)}',
    '.ipc-btn-reject{background:var(--text-mid);color:var(--white);border-color:var(--text-mid)}',
    '.ipc-btn-settings{background:var(--surface);color:var(--blue);border-color:var(--border-2);min-width:0;padding:11px 16px;font-weight:600}',
    '.ipc-btn:hover{filter:brightness(1.07)}',
    '.ipc-btn:focus-visible,.ipc-toggle input:focus-visible+.ipc-track{outline:3px solid var(--blue-light);outline-offset:2px}',
    '.ipc-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(13,27,62,.55);display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto}',
    '.ipc-panel-card{background:var(--surface);border-radius:var(--radius);max-width:560px;width:100%;box-shadow:var(--shadow-lg);padding:26px}',
    '.ipc-panel-card h2{font-family:"Syne",system-ui,sans-serif;font-size:1.25rem;margin:0 0 8px;line-height:1.2}',
    '.ipc-panel-intro{font-size:.86rem;color:var(--text-mid);line-height:1.6;margin:0 0 18px}',
    '.ipc-panel-intro a{color:var(--blue);text-decoration:underline}',
    '.ipc-row{border:1.5px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:12px;display:flex;gap:14px;align-items:flex-start}',
    '.ipc-row-main{flex:1}',
    '.ipc-row h3{font-family:"Syne",system-ui,sans-serif;font-size:.98rem;margin:0 0 4px}',
    '.ipc-row p{font-size:.82rem;color:var(--text-light);line-height:1.55;margin:0}',
    '.ipc-locked{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--green);background:var(--green-pale);border-radius:999px;padding:5px 10px;white-space:nowrap}',
    '.ipc-toggle{position:relative;flex:0 0 auto;display:inline-block;width:46px;height:26px}',
    '.ipc-toggle input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}',
    '.ipc-track{position:absolute;inset:0;background:var(--border-2);border-radius:999px;transition:background .15s ease;pointer-events:none}',
    '.ipc-track::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--white);transition:transform .15s ease;box-shadow:0 1px 4px rgba(13,27,62,.25)}',
    '.ipc-toggle input:checked+.ipc-track{background:var(--blue)}',
    '.ipc-toggle input:checked+.ipc-track::after{transform:translateX(20px)}',
    '.ipc-panel-foot{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}',
    '.ipc-note{font-size:.78rem;color:var(--text-light);line-height:1.55;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}',
    /* MOBILE. `flex:1 1 340px` on the text is right in a row and wrong in a
       column: stacked, it grows to eat the free space and pushes the buttons to
       the bottom of a banner that then covers half the viewport with a blank gap
       in the middle. Pinned to its content height, and the whole banner capped.

       THE SAFE-AREA PADDING IS NOT COSMETIC. This banner is position:fixed at
       bottom:0 on a page that already has a fixed bottom nav (.mobile-nav,
       z-index 100). At z-index 2147483000 the banner covers that nav, which is
       correct while a decision is outstanding, but it also means the banner
       inherits the nav's problem: on a notched iPhone the bottom edge sits under
       the home indicator, and the Reject button is the one at the bottom of the
       stacked layout. .mobile-nav solves this with max(8px, safe-area-inset) and
       this uses the same idiom, because a consent control that is hard to press
       is not equal in prominence whatever the CSS says. */
    '@media (max-width:640px){' +
      '.ipc-banner{padding:14px 16px max(14px,env(safe-area-inset-bottom));max-height:70vh;overflow-y:auto}' +
      '.ipc-banner-inner{flex-direction:column;align-items:stretch;gap:14px}' +
      '.ipc-banner-text{flex:0 0 auto;min-width:0}' +
      '.ipc-actions{width:100%}' +
      '.ipc-btn{flex:1 1 auto}' +
    '}'
  ].join('');

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var st = document.createElement('style');
    st.id = 'ipc-styles';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  var bannerEl = null;

  function openBanner() {
    if (bannerEl) return;
    injectStyles();
    bannerEl = document.createElement('div');
    bannerEl.className = 'ipc-banner';
    bannerEl.setAttribute('role', 'region');
    bannerEl.setAttribute('aria-label', 'Cookie consent');
    // COPY NAMES ONLY WHAT THIS ORIGIN SETS. The site's banner says "analytics
    // and affiliate tracking"; saying that here would describe a vendor that is
    // not on this origin and a toggle that is not in this panel.
    bannerEl.innerHTML =
      '<div class="ipc-banner-inner">' +
        '<div class="ipc-banner-text">' +
          '<strong>Cookies in the members area</strong>' +
          'We use essential cookies to keep you signed in and to remember this choice. ' +
          'We would also like to set analytics cookies, but only if you agree. You can ' +
          'change your mind at any time under Settings. ' +
          '<a href="' + esc(PRIVACY_URL) + '" target="_blank" rel="noopener">Read our privacy policy</a>.' +
        '</div>' +
        '<div class="ipc-actions">' +
          '<button type="button" class="ipc-btn ipc-btn-accept" data-ipc="accept">Accept</button>' +
          '<button type="button" class="ipc-btn ipc-btn-reject" data-ipc="reject">Reject</button>' +
          '<button type="button" class="ipc-btn ipc-btn-settings" data-ipc="settings">Settings</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bannerEl);

    bannerEl.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-ipc]');
      if (!t) return;
      var action = t.getAttribute('data-ipc');
      // "Accept" and "Reject" cover the categories THIS ORIGIN ASKS ABOUT.
      // buildRecord carries the rest of the record forward untouched, which is
      // why these can safely be all-or-nothing over one category.
      if (action === 'accept') decide(allAppCategories(true), 'banner-accept');
      else if (action === 'reject') decide(allAppCategories(false), 'banner-reject');
      else if (action === 'settings') openPanel();
    });
  }

  function closeBanner() {
    if (!bannerEl) return;
    bannerEl.parentNode && bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  // ── Settings panel ────────────────────────────────────────────────────────
  var panelEl = null;
  var lastFocus = null;

  function openPanel() {
    if (panelEl) return;
    injectStyles();
    lastFocus = document.activeElement;
    var rec = readRecord();
    var current = (rec && rec.choices) || allAppCategories(false);

    // APP_CATEGORIES, not RECORD_CATEGORIES. The other two keys are in the
    // record and are not shown, not even as disabled toggles: a control a
    // member cannot operate, over a vendor that is not on this origin, tells
    // them something untrue about what this page does.
    var rows = APP_CATEGORIES.map(function (c) {
      return '<div class="ipc-row">' +
        '<div class="ipc-row-main">' +
          '<h3>' + esc(c.title) + '</h3>' +
          '<p>' + esc(c.body) + '</p>' +
        '</div>' +
        '<label class="ipc-toggle">' +
          '<input type="checkbox" data-ipc-cat="' + esc(c.key) + '"' +
            (current[c.key] ? ' checked' : '') +
            ' aria-label="' + esc(c.title) + '">' +
          '<span class="ipc-track"></span>' +
        '</label>' +
      '</div>';
    }).join('');

    panelEl = document.createElement('div');
    panelEl.className = 'ipc-overlay';
    panelEl.innerHTML =
      '<div class="ipc-panel-card" role="dialog" aria-modal="true" aria-labelledby="ipc-panel-title">' +
        '<h2 id="ipc-panel-title">Cookie settings</h2>' +
        '<p class="ipc-panel-intro">Choose what we may set in the members area. Turning something ' +
          'off here stops it loading from your next visit onwards. Full detail is in our ' +
          '<a href="' + esc(PRIVACY_URL) + '" target="_blank" rel="noopener">privacy policy</a>.</p>' +
        '<div class="ipc-row">' +
          '<div class="ipc-row-main">' +
            '<h3>Essential</h3>' +
            '<p>Needed for the members area to work, including keeping you signed in and the ' +
               'record of the choice you make here. These are not used to track you and cannot ' +
               'be switched off.</p>' +
          '</div>' +
          '<span class="ipc-locked">Always on</span>' +
        '</div>' +
        rows +
        '<div class="ipc-panel-foot">' +
          '<button type="button" class="ipc-btn ipc-btn-accept" data-ipc="save">Save choices</button>' +
          '<button type="button" class="ipc-btn ipc-btn-reject" data-ipc="reject">Reject all</button>' +
          '<button type="button" class="ipc-btn ipc-btn-settings" data-ipc="close">Close</button>' +
        '</div>' +
        // THIS SENTENCE IS LOAD-BEARING, not reassurance. The record is shared
        // with ipredicta.co, so a member changing it here changes what happens
        // there too, and they are entitled to know that before they save.
        '<p class="ipc-note">This choice applies to iPredicta.co as well as the members area, ' +
          'because we remember it once rather than asking you twice. Anything already loaded ' +
          'before you changed this cannot be unloaded from the page you are on. Reload, or ' +
          'carry on, and the new choice applies.</p>' +
      '</div>';
    document.body.appendChild(panelEl);

    panelEl.addEventListener('click', function (ev) {
      if (ev.target === panelEl) { closePanel(); return; }
      var t = ev.target.closest('[data-ipc]');
      if (!t) return;
      var action = t.getAttribute('data-ipc');
      if (action === 'close') { closePanel(); return; }
      if (action === 'reject') { decide(allAppCategories(false), 'settings-save'); return; }
      if (action === 'save') {
        var choices = {};
        APP_CATEGORIES.forEach(function (c) {
          var input = panelEl.querySelector('[data-ipc-cat="' + c.key + '"]');
          choices[c.key] = !!(input && input.checked);
        });
        decide(choices, 'settings-save');
      }
    });

    document.addEventListener('keydown', onPanelKey);
    var first = panelEl.querySelector('button, input');
    first && first.focus();
  }

  function onPanelKey(ev) {
    if (ev.key === 'Escape') closePanel();
  }

  function closePanel() {
    if (!panelEl) return;
    document.removeEventListener('keydown', onPanelKey);
    panelEl.parentNode && panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
    try { lastFocus && lastFocus.focus && lastFocus.focus(); } catch (e) { /* ignore */ }
    // If the member opened the panel from the banner and closed it without
    // choosing, the banner must come back. Otherwise "Settings" then "Close"
    // would be a way to dismiss the banner without a decision.
    if (!hasCurrentDecision()) openBanner();
  }

  function hasCurrentDecision() {
    var rec = readRecord();
    return !!(rec && rec.policy_version === POLICY_VERSION && rec.choices);
  }

  // ── Public surface ────────────────────────────────────────────────────────
  // openSettings() is what the Cookie settings row in the Settings view calls.
  // pageView() is what showView() and enterApp() call.
  window.iPredictaConsent = {
    openSettings: openPanel,
    getRecord: readRecord,
    policyVersion: POLICY_VERSION,
    pageView: pageView,
    // For anything that needs to know, rather than re-reading the cookie and
    // re-implementing the version check. Nothing uses it yet.
    analyticsEnabled: function () {
      var rec = readRecord();
      return !!(rec && rec.policy_version === POLICY_VERSION &&
                rec.choices && rec.choices.analytics);
    }
  };

  // ── Boot ──────────────────────────────────────────────────────────────────
  // THE BANNER IS NOT GATED ON BEING SIGNED IN. PECR bites when something is
  // stored on or read from the device, which happens on load, not on sign-in. So
  // a visitor looking at the sign-in form gets the same decision to make as a
  // member looking at the dashboard, and a member who already decided on
  // ipredicta.co sees nothing here at all, which is the point of the shared
  // cookie.
  function boot() {
    var rec = readRecord();
    // No cookie yet. Before concluding nobody has decided, look for a record
    // written by the localStorage era and carry it forward. See the note on
    // migrateFromLocalStorage for why this is kept on an origin that has never
    // written one.
    if (!rec) rec = migrateFromLocalStorage();
    if (rec && rec.choices && rec.policy_version === POLICY_VERSION) {
      applyChoices(rec.choices);
      return;
    }
    // No decision, or one made against a policy version that no longer
    // describes what we set. Either way nothing non-essential loads until there
    // is a fresh decision. A stale record is not carried forward as implied
    // consent.
    openBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
