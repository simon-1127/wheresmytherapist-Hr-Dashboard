const { Pool } = require('pg');

// Deliberate exception to this app's normal "everything through the Supabase
// client" convention (see config/supabase.js) — used only by the crisis/
// support-team feature (routes/support.routes.js), per an explicit request
// to minimize Supabase usage for that specific feature. Nothing else in
// this app should import this.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Postgres connection string, not the Supabase client config
});

module.exports = { pool };
