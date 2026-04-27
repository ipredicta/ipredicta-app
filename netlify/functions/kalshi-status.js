'use strict';
const { createClient } = require('@supabase/supabase-js');
const { decrypt, maskKey } = require('./_crypto');

const SB_URL = 'https://xcjoclataeywhneruqrg.supabase.co';

function makeServiceClient() {
  return createClient(SB_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
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

  const { data: prefs, error: fetchErr } = await sb.from('user_preferences')
    .select('kalshi_api_key')
    .eq('user_id', user.id)
    .maybeSingle();

  if (fetchErr) {
    console.error('DB fetch failed:', fetchErr.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DB error' }) };
  }

  const stored = prefs?.kalshi_api_key;
  if (!stored) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connected: false, masked: null })
    };
  }

  let plaintext;
  if (stored.startsWith('v1:')) {
    try {
      plaintext = decrypt(stored);
    } catch (e) {
      console.error('Decryption failed for user', user.id, e.message);
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Decryption error' }) };
    }
  } else {
    console.error('Pre-migration plaintext kalshi_api_key for user', user.id);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Account migration required, please contact support' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connected: true, masked: maskKey(plaintext) })
  };
};
