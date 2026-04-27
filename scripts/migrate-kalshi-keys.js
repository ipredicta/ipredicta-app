'use strict';
/**
 * One-shot migration: encrypt all plaintext kalshi_api_key rows with AES-256-GCM.
 *
 * Prerequisites:
 *   1. Take a Supabase DB snapshot BEFORE running this.
 *   2. Set env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KALSHI_ENCRYPTION_KEY
 *
 * Run: node scripts/migrate-kalshi-keys.js
 */

const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');
const { encrypt } = require('../netlify/functions/_crypto');

const SB_URL = process.env.SUPABASE_URL || 'https://xcjoclataeywhneruqrg.supabase.co';

function makeServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createClient(SB_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log('=== Kalshi API key encryption migration ===\n');
  console.log('IMPORTANT: Have you taken a Supabase DB snapshot before running this? (y/n)');
  const snap = await prompt('> ');
  if (snap.toLowerCase() !== 'y') {
    console.log('Aborted. Take a snapshot first.');
    process.exit(0);
  }

  const sb = makeServiceClient();

  const { data: rows, error: fetchErr } = await sb
    .from('user_preferences')
    .select('user_id, kalshi_api_key')
    .not('kalshi_api_key', 'is', null);

  if (fetchErr) {
    console.error('Failed to fetch rows:', fetchErr.message);
    process.exit(1);
  }

  const pending = rows.filter(r => !r.kalshi_api_key.startsWith('v1:'));
  const alreadyMigrated = rows.length - pending.length;

  console.log(`\nTotal rows with kalshi_api_key: ${rows.length}`);
  console.log(`Already encrypted (v1: prefix):  ${alreadyMigrated}`);
  console.log(`Rows to encrypt:                  ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('Nothing to do. All rows already encrypted.');
    process.exit(0);
  }

  const confirm = await prompt(`Encrypt ${pending.length} row(s)? Type YES to proceed: `);
  if (confirm !== 'YES') {
    console.log('Aborted.');
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;

  for (const row of pending) {
    // Skip encrypted rows (belt-and-suspenders guard)
    if (row.kalshi_api_key.startsWith('v1:')) {
      console.log(`[skip] ${row.user_id} — already encrypted`);
      continue;
    }

    let ciphertext;
    try {
      ciphertext = encrypt(row.kalshi_api_key);
    } catch (e) {
      console.error(`[error] ${row.user_id} — encrypt failed: ${e.message}`);
      failed++;
      continue;
    }

    const { error: updateErr } = await sb
      .from('user_preferences')
      .update({ kalshi_api_key: ciphertext })
      .eq('user_id', row.user_id);

    if (updateErr) {
      console.error(`[error] ${row.user_id} — DB update failed: ${updateErr.message}`);
      failed++;
    } else {
      console.log(`[ok]   ${row.user_id}`);
      succeeded++;
    }
  }

  console.log(`\nDone. Encrypted: ${succeeded}, Failed: ${failed}`);
  if (failed > 0) {
    console.error('Some rows failed — check logs and re-run. Failed rows are still plaintext.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
