// THE MEMBERS AREA ASKS WHAT THE SITE ASKS (the owner, 24 Nov 2026). Nobody is asked twice: a current site decision is
// taken as it stands, and with none the members area asks with the site's version, the site's two categories and the
// site's wording, word for word except one phrase ("from Cookie settings under Settings", because the site's "Cookie
// settings link in the footer" does not exist here). This compares public/assets/consent.js with the SITE's consent.js
// and allows exactly that difference, so a site bump that is not made here fails this test instead of quietly
// re-asking every member on both origins (29 Oct to 24 Nov 2026).
//
// The site file is read from IPREDICTA_SITE_CONSENT_JS (a path), else from the site repository's main branch
// (IPREDICTA_SITE_REPO, default ~/code/ipredicta-site, fetched first). Not from production: ipredicta.co serves a
// minified copy with the names this reads stripped. It never skips: with neither readable it fails, because a parity
// check that passes when it cannot see the other side is no check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const SITE_FILE = 'ipredicta 3/assets/js/consent.js';
const MEMBERS = fs.readFileSync(new URL('../public/assets/consent.js', import.meta.url), 'utf8');
const ALLOWED = [['from the Cookie settings link in the footer', 'from Cookie settings under Settings']];

let siteCache = null;
async function siteSource() {
  if (siteCache) return siteCache;
  const p = process.env.IPREDICTA_SITE_CONSENT_JS;
  if (p) return (siteCache = fs.readFileSync(p, 'utf8'));
  const repo = process.env.IPREDICTA_SITE_REPO || path.join(os.homedir(), 'code', 'ipredicta-site');
  try { execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin', 'main'], { stdio: 'ignore', timeout: 30000 }); } catch (e) { /* read what is there */ }
  try {
    return (siteCache = execFileSync('git', ['-C', repo, 'show', `origin/main:${SITE_FILE}`], { encoding: 'utf8', maxBuffer: 1 << 24 }));
  } catch (e) {
    assert.fail(`could not read the site's ${SITE_FILE} from ${repo} (set IPREDICTA_SITE_REPO or IPREDICTA_SITE_CONSENT_JS)`);
  }
}

const versionOf = (src) => (src.match(/var POLICY_VERSION = '([^']+)'/) || [])[1];

// The category list as data: the array literal after `var <name> =`, evaluated on its own.
function categoriesOf(src, name) {
  const at = src.indexOf(`var ${name} = [`);
  assert.ok(at >= 0, `no ${name} in the file`);
  let i = src.indexOf('[', at), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) { end = j; break; }
  }
  // Through JSON: arrays from another vm context have another Array prototype, which deepEqual counts as a difference.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${src.slice(i, end + 1)})`))).map(({ key, title, body, vendors }) => ({ key, title, body, vendors }));
}

// What a reader sees in an innerHTML assignment: its string literals joined, tags stripped, spaces collapsed. Hrefs and
// attributes are code, not wording, so they drop out with the tags.
function wordingOf(src, target) {
  const at = src.indexOf(`${target}.innerHTML =`);
  assert.ok(at >= 0, `no ${target}.innerHTML in the file`);
  const stmt = src.slice(at, src.indexOf("</div>';", at) + 8);
  const lits = [...stmt.replace(/^\s*\/\/.*$/gm, '').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('');
  return lits.replace(/<[^>]*>/g, ' ').replace(/&middot;/g, '.').replace(/\s+/g, ' ').trim();
}
const allow = (s) => ALLOWED.reduce((t, [site, here]) => t.split(site).join(here), s);

test('the members area uses the site\'s policy version', async () => {
  const site = await siteSource();
  assert.ok(versionOf(site), 'the site file has a POLICY_VERSION');
  assert.equal(versionOf(MEMBERS), versionOf(site));
});

test('the members area asks exactly the site\'s categories, with the site\'s titles, text and vendors', async () => {
  const site = await siteSource();
  assert.deepEqual(categoriesOf(MEMBERS, 'APP_CATEGORIES'), categoriesOf(site, 'CATEGORIES'));
  const rec = MEMBERS.match(/var RECORD_CATEGORIES = (\[[^\]]*\])/)[1];
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(rec))), categoriesOf(site, 'CATEGORIES').map((c) => c.key));
});

test('the banner and the panel say what the site says, with only the one allowed phrase changed', async () => {
  const site = await siteSource();
  for (const target of ['bannerEl', 'panelEl']) {
    assert.equal(wordingOf(MEMBERS, target), allow(wordingOf(site, target)), `${target} wording`);
  }
  // The allowed difference is used, and only where the site has the phrase it replaces.
  assert.ok(wordingOf(site, 'bannerEl').includes(ALLOWED[0][0]), 'the site still says "the Cookie settings link in the footer"');
  assert.ok(wordingOf(MEMBERS, 'bannerEl').includes(ALLOWED[0][1]));
});
