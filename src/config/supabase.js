const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  // Fail loudly at boot rather than mysteriously later — this dashboard
  // only ever talks to Supabase with the service role key (never a client
  // anon key), same as the rest of the app's privileged writes.
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.');
}

// service role key bypasses RLS — appropriate here since this whole app IS
// the trusted admin backend, but it means every route must do its own
// authorization checks (see src/middleware/auth.js). Never expose this
// client or its key to any browser-side code.
const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabase };
