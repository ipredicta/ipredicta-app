'use strict';
const { createClient } = require('@supabase/supabase-js');

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

  const sb = makeServiceClient();

  const { data: { user }, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !user) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  const { error: updateErr } = await sb.from('user_preferences')
    .update({ kalshi_api_key: null })
    .eq('user_id', user.id);

  if (updateErr) {
    console.error('DB update failed:', updateErr.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DB error' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
