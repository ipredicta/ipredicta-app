'use strict';
const crypto = require('crypto');
const { noindex } = require('../lib/robots.js');
const { createClient } = require('@supabase/supabase-js');

const SB_URL = 'https://xcjoclataeywhneruqrg.supabase.co';

function makeServiceClient() {
  return createClient(SB_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// crypto.randomInt, not Math.random (30 Oct 2026): the code is what links a Telegram chat to a member, so it must not be
// predictable. Same IP-XXXX shape the bot parses; the bot also limits wrong tries per chat (ipredicta-telegram).
function genCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 'IP-';
  for (let i = 0; i < 4; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = (event.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sb = makeServiceClient();

  const { data: { user }, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !user) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  // Remove any existing unconsumed codes for this user
  await sb.from('telegram_link_codes')
    .delete()
    .eq('user_id', user.id)
    .is('consumed_at', null);

  // Generate a unique code (collision extremely unlikely but guard anyway)
  let code;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = genCode();
    const { data: clash } = await sb.from('telegram_link_codes')
      .select('code').eq('code', candidate).maybeSingle();
    if (!clash) { code = candidate; break; }
  }
  if (!code) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Code generation failed' }) };
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { error: insertErr } = await sb.from('telegram_link_codes').insert({
    code,
    user_id: user.id,
    expires_at: expiresAt
  });

  if (insertErr) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DB insert failed', detail: insertErr.message }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, expires_at: expiresAt })
  };
};

// Wrapped so EVERY return path carries X-Robots-Tag: noindex. See _robots.js.
exports.handler = noindex(handler);
