// Direct-Postgres reads for the Sessions section (search, names, audit
// trail) — same pattern as the support console. Everything that changes
// money or outcomes goes through the backend API instead (lib/backend.js).

const { query } = require('../config/db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Session search. `q` can be a full session id, the first 6+ characters of
 * one (what people copy from an email subject), or part of a client /
 * provider name or email. Date bounds are IST calendar days.
 */
async function searchSessions({ q, status, from, to, userId, review, limit = 50 } = {}) {
  const term = (q || '').trim();
  const fullId = UUID_RE.test(term) ? term : null;
  const idPrefix = !fullId && /^[0-9a-f-]{6,35}$/i.test(term) ? `${term.toLowerCase()}%` : null;
  const text = term && !fullId && !idPrefix ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const { rows } = await query(
    `SELECT s.id, s.status::text AS status, s.scheduled_start, s.scheduled_end,
            s.actual_start, s.actual_end, s.amount, s.fault, s.needs_review, s.review_reason,
            s.client_id, s.provider_id, s.root_session_id, s.reschedule_count,
            cu.email AS client_email, COALESCE(cp.full_name, cu.email) AS client_name,
            pu.email AS provider_email, COALESCE(pp.full_name, pu.email) AS provider_name,
            st.status AS settlement_status,
            (SELECT COALESCE(SUM(r.amount), 0)::int FROM refunds r
              WHERE r.session_id = s.id AND r.status <> 'failed') AS refunded_amount
       FROM sessions s
       JOIN users cu ON cu.id = s.client_id
       LEFT JOIN client_profiles cp ON cp.user_id = s.client_id
       JOIN users pu ON pu.id = s.provider_id
       LEFT JOIN provider_profiles pp ON pp.user_id = s.provider_id
       LEFT JOIN session_settlements st ON st.session_id = s.id
      WHERE ($1::uuid IS NULL OR s.id = $1 OR s.root_session_id = $1 OR s.rescheduled_from_session_id = $1)
        AND ($2::text IS NULL OR s.id::text LIKE $2)
        AND ($3::text IS NULL OR cp.full_name ILIKE $3 OR cu.email ILIKE $3
             OR pp.full_name ILIKE $3 OR pu.email ILIKE $3)
        AND ($4::text IS NULL OR s.status::text = $4)
        AND ($5::uuid IS NULL OR s.client_id = $5 OR s.provider_id = $5)
        AND ($6::date IS NULL OR s.scheduled_start >= ($6::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ($7::date IS NULL OR s.scheduled_start < ($7::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND ($8::boolean IS NULL OR s.needs_review = $8)
      ORDER BY s.scheduled_start DESC
      LIMIT $9`,
    [fullId, idPrefix, text, status || null, userId || null, from || null, to || null, review === undefined ? null : review, limit],
  );
  return rows;
}

/** Names/emails for the two parties — the evidence API returns ids. */
async function parties(clientId, providerId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.phone, u.role::text AS role,
            COALESCE(cp.full_name, pp.full_name) AS full_name
       FROM users u
       LEFT JOIN client_profiles cp ON cp.user_id = u.id
       LEFT JOIN provider_profiles pp ON pp.user_id = u.id
      WHERE u.id = ANY($1::uuid[])`,
    [[clientId, providerId].filter(Boolean)],
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return { client: byId[clientId] || null, provider: byId[providerId] || null };
}

/** Emails for any user ids that appear in the evidence (actors, deciders). */
async function emailsFor(ids) {
  const list = [...new Set((ids || []).filter((v) => UUID_RE.test(String(v))))];
  if (!list.length) return {};
  const { rows } = await query('SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [list]);
  return Object.fromEntries(rows.map((r) => [r.id, r.email]));
}

/**
 * Audit entries touching this session: written against the session itself,
 * against one of its refunds, or carrying the session id in details.
 */
async function auditForSession(sessionId, relatedIds = []) {
  const { rows } = await query(
    `SELECT l.id, l.action, l.target_table, l.target_id, l.details, l.created_at, l.admin_id,
            u.email AS admin_email
       FROM admin_audit_log l
       LEFT JOIN users u ON u.id = l.admin_id
      WHERE l.target_id = $1
         OR l.target_id = ANY($2::uuid[])
         OR l.details->>'session_id' = $1::text
      ORDER BY l.created_at DESC
      LIMIT 50`,
    [sessionId, relatedIds.filter((v) => UUID_RE.test(String(v)))],
  );
  return rows;
}

module.exports = { searchSessions, parties, emailsFor, auditForSession, UUID_RE };
