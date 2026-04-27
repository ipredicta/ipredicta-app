'use strict';
const { createClient } = require('@supabase/supabase-js');
const { encrypt } = require('./_crypto');

const SB_URL = 'https://xcjoclataeywhneruqrg.supabase.co';

function makeServiceClient() {
  return createClient(SB_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = (event.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const apiKey = (body.api_key || '').trim();
  if (!apiKey) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'api_key is required' }) };
  }

  const sb = makeServiceClient();

  const { data: { user }, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !user) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  let ciphertext;
  try {
    ciphertext = encrypt(apiKey);
  } catch (e) {
    console.error('Encryption failed:', e.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Encryption error' }) };
  }

  const { error: upsertErr } = await sb.from('user_preferences').upsert(
    { user_id: user.id, kalshi_api_key: ciphertext },
    { onConflict: 'user_id' }
  );

  if (upsertErr) {
    console.error('DB upsert failed:', upsertErr.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DB error' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
