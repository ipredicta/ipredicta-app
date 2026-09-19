# ROADMAP — ipredicta-app (members area)

Strategy and sequencing. Defects live in TECH_DEBT.md.

Opened 2026-09-19 alongside the consent and GA4 work. NOW is what should happen before this
change is considered finished; NEXT is what it makes possible; LATER is what it will force a
decision about eventually.

---

## NOW

### Give this origin a consent-log endpoint

The members area can now take a consent decision it cannot record. That is the one thing
shipped here that is worse than what the site does, and it is not a detail: the record in
`public.consent_records` is the whole of our Article 7(1) evidence, and decisions made here
are absent from it.

Not solvable from the browser. The site's `consent-log` is same-origin-only by construction,
and adding CORS to it would mean editing the site, widening a public write endpoint to a
second origin, and doing it for a function whose whole design assumes it is talking to its
own pages. The right shape is `netlify/functions/consent-log.js` in **this** repo, writing to
the same table with the same whitelist.

**Nothing outside the code blocks this.** Checked on 19 September 2026 with
`netlify env:list` against the `ipredicta-app` site: `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are both **already set** there, because the Kalshi and Telegram
functions need them. So this is a write-the-function job with no ops step in front of it,
which makes it a good deal smaller than it first looked.

**The table is already there and the site's logging works.** Migration 029 was applied on
14 August 2026 and verified end to end the same day, so writing this endpoint is adding a
second writer to a working table, not standing up a new one. Measured on 19 September 2026
rather than read from the migration header: `consent_records` holds **220 rows**, earliest
`2026-08-15T09:21:55`, and rows were still arriving that evening, including three within ten
minutes of the cookie change going live. Split by version: 5 at `2026-08-14.1`, 215 at
`2026-08-17.1`.

**Queried with the SERVICE key, and that has to be said for the count to mean anything.**
An anon SELECT on this table returns `200 []` rather than `401`, and `Prefer: count=exact`
does not distinguish them, so "220 rows" is a claim about a key as much as about a table.
Never state what `consent_records` contains without naming the key that read it.

Copy the site's function rather than reinventing it, including the part where every failure
path returns 204 and logs loudly. A member's privacy choice must not surface an error.

### Decide what happens to a member whose first decision is made here

**This is a consequence of the brief, discovered while implementing it, and it needs a
ruling rather than code.**

The members area asks about Analytics only. When a member has no existing record and answers
here, `marketing` and `reviews` are written `false`, because this origin cannot ask about
vendors it does not have. The record is then a complete, current-version decision, so
**ipredicta.co will not show that person a banner either.** They are never offered the
affiliate-tracking or reviews choice unless they find Cookie settings in the site footer.

It fails closed, which is the right direction, and nothing tracks anyone who did not ask for
it. But "we never asked" and "they said no" are recorded identically, and only the second is
true.

Three options, none of them free:

1. **Leave it.** Defensible: the choice is always reachable, and the failure is towards not
   tracking. The site's footer link is the remedy.
2. **Make the record say where it was decided** (a `decided_on` or a per-category
   `asked` map) and have the site re-prompt for categories never offered. Correct, and it
   changes the shared record shape, which means changing the site, the consent-log whitelist
   and migration 029 together.
3. **Show all three categories here**, with the two that do not apply marked as governing
   the main site. Rejected in this implementation because the brief forbade it, and because
   a toggle for a vendor that is not on this origin is its own kind of untruth.

Option 1 is what ships today. It should be a decision, not a default.

## NEXT

### Instrument the sign-in and sign-up screens

GA4 currently sees every session begin at `/app/home`. Nobody can answer "how many people
start sign-up and finish it", which is the first question anyone will ask of this data. Two
call sites, `enterAuth()` and `showAuthForm()`, and one rule: no email, no token, no `mode`
query value that could carry anything but `signup`. See TECH_DEBT.md #4.

### One source for POLICY_VERSION

Two hand-copied constants in two repositories, and a mismatch prompts members for ever
without erroring. See TECH_DEBT.md #2. Worth doing before the next policy change rather than
during it.

### A build command, so a check has somewhere to live

There is nowhere to wire a test in this repo because `netlify.toml` has no `[build] command`.
Adding one that runs `node --check` over `public/assets/consent.js` and the extracted inline
block costs nothing and closes the gap where a syntax error reaches production untouched.
Prerequisite for anything else in TECH_DEBT.md #6.

### Verify the shared decision end to end, on the real domains

The cookie was verified live on `ipredicta.co` on 2026-09-19. The half this work adds, that
`app.ipredicta.co` reads the same record and asks nobody twice, has been proven only against
a DOM shim, because a deploy preview is not on `.ipredicta.co` and the `Domain` attribute is
rejected off it. The first real evidence arrives on the first load after this merges:

1. Decide on `ipredicta.co`, then open the members area. **Expect no banner**, and analytics
   loading or not according to what was chosen.
2. Decide in the members area, then reload `ipredicta.co`. **Expect no banner.**
3. Accept in the members area, then open devtools on the site and confirm the affiliate
   choice made there is still whatever it was.

Step 3 is the one that catches the category-preservation bug if it ever returns.

## LATER

### The point at which a hand-written mechanism stops being the right answer

The site's ROADMAP carries a CMP crossover trigger: conditions about the number of
categories and the number of vendors, past which a hand-rolled consent mechanism costs more
than a bought one. **This change adds a second property to that calculation**, and the
trigger was written when there was one.

Two implementations of the same policy, in two repositories, sharing a cookie and a version
constant that nothing compares, is exactly the shape the trigger exists to catch. Read the
site's entry before adding a category to either, and treat "a second origin" as worth a
condition of its own.

### Analytics on the members area may be the wrong instrument

GA4 answers "which screens are used". The questions actually worth asking about a members
area are mostly about a known member over time: do people who connect Kalshi set more
alerts, does anyone return after week one. Those are database questions, and the answers are
already in Supabase, unsampled, without sending anything to Google or needing consent at all.

Nothing here is wasted: consent had to exist regardless, and screen counts are a reasonable
first read. But before anyone invests in GA4 events, custom dimensions or a funnel, note
that the better data is in-house and needs no permission from anybody.

### Consent for a signed-in member could be stored server-side

The record is a cookie, so it travels per browser. A member who signs in on a phone and a
laptop answers twice, and clearing cookies loses the decision on both properties. Once
`consent_records` is being written from here, the row could be keyed to the member and read
back at sign-in. Better UX and better evidence, and it is the natural second step after the
NOW item rather than a separate project.
