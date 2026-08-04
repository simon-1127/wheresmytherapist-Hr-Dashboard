const { Pool } = require('pg');

// Deliberate exception to this app's normal "everything through the Supabase
// client" convention (see config/supabase.js) — used only by the crisis/
// support-team feature (routes/support.routes.js and lib/supportQueries.js),
// per an explicit request to minimize Supabase usage for that specific
// feature. Nothing else in this app should import this.

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set. Every /support page will fail until it is — ' +
      'those pages talk to Postgres directly rather than going through Supabase.',
  );
}

// Supabase terminates TLS but its chain is not in the default trust store on
// most hosts, so verification is relaxed the same way `sslmode=require` does
// in psql. Set PGSSL=disable for a plain local Postgres.
const sslDisabled = process.env.PGSSL === 'disable';
const looksLikeSupabase = /supabase\.(co|com)/i.test(connectionString || '');

const pool = new Pool({
  connectionString,
  ssl: !sslDisabled && (looksLikeSupabase || process.env.PGSSL === 'require')
    ? { rejectUnauthorized: false }
    : undefined,
  // Railway free tier in front of the Supabase pooler — a small ceiling is
  // both plenty for this dashboard and kinder to the pooler's client limit.
  max: 5,
  connectionTimeoutMillis: 8000,
  idleTimeoutMillis: 30000,
});

/**
 * Node's happy-eyeballs connect throws an AggregateError whose own `message`
 * is an empty string — which is exactly how a DB outage reached the browser
 * as a blank "Something went wrong" page. Flatten it into something a human
 * can act on.
 */
function describeDbError(err) {
  if (!err) return 'unknown error';
  if (Array.isArray(err.errors) && err.errors.length) {
    const parts = err.errors.map((e) => e.message || e.code).filter(Boolean);
    return `${err.code || 'connection failed'} — ${[...new Set(parts)].join('; ')}`;
  }
  return err.message || err.code || String(err);
}

async function query(text, params) {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set — the support/crisis pages need a direct Postgres connection string.',
    );
  }
  try {
    return await pool.query(text, params);
  } catch (err) {
    const wrapped = new Error(`Postgres: ${describeDbError(err)}`);
    wrapped.cause = err;
    // Keep the original stack visible in the server log; the wrapper only
    // exists to give the error a message worth rendering.
    console.error('[db] query failed:', describeDbError(err), '\n', err.stack || err);
    throw wrapped;
  }
}

// An idle client dying (pooler timeout, network blip) is emitted here rather
// than at a call site, and an unhandled 'error' event would take the process
// down — so it always needs a listener.
pool.on('error', (err) => {
  console.error('[db] idle client error:', describeDbError(err));
});

module.exports = { pool, query, describeDbError };
