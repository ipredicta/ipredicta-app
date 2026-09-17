'use strict';
const { noindex } = require('../lib/robots.js');
const { createClient } = require('@supabase/supabase-js');

const SB_URL = 'https://xcjoclataeywhneruqrg.supabase.co';

function makeServiceClient() {
  return createClient(SB_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
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

  // Unlink in telegram_users (clear user_id and linked_at)
  await sb.from('telegram_users')
    .update({ user_id: null, linked_at: null })
    .eq('user_id', user.id);

  // Clear telegram_chat_id in user_preferences
  await sb.from('user_preferences')
    .update({ telegram_chat_id: null })
    .eq('user_id', user.id);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};

// Wrapped so EVERY return path carries X-Robots-Tag: noindex. See _robots.js.
exports.handler = noindex(handler);
