const { pool } = require('../config/db');

// Every query in this file goes through the raw pg pool, never the Supabase
// client — the support/crisis feature is deliberately kept off Supabase.
// That includes the audit log writes below, which is why this file has its
// own logger instead of importing lib/audit.js.

// ---------------------------------------------------------------- audit ---

async function logSupportAction({ adminId, action, targetTable, targetId, details }) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_table, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [adminId, action, targetTable, targetId, JSON.stringify(details || {})],
    );
  } catch (err) {
    // Same rule as lib/audit.js: never let an audit failure block the action.
    console.error('[support/audit] failed to write admin_audit_log:', err.message);
  }
}

// --------------------------------------------------------------- alerts ---

/**
 * The crisis queue. Ordering is the whole point of this screen: unhandled
 * first, then by severity, then oldest-of-the-new last so nothing quietly
 * ages out at the bottom of the list.
 */
async function listAlerts({ status, severity, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, a.severity, a.status, a.trigger_type, a.is_minor,
            a.similarity_score, a.created_at, a.acknowledged_at, a.resolved_at,
            a.assigned_to, a.source_table, a.source_message_id,
            cp.full_name, u.email, u.phone,
            k.phrase AS matched_phrase,
            assignee.email AS assigned_email
       FROM crisis_alerts a
       JOIN client_profiles cp ON cp.user_id = a.user_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN crisis_keywords k ON k.id = a.matched_keyword_id
       LEFT JOIN users assignee ON assignee.id = a.assigned_to
      WHERE ($1::text IS NULL OR a.status::text = $1::text)
        AND ($2::int IS NULL OR a.severity >= $2::int)
      ORDER BY (a.status = 'new') DESC,
               (a.status = 'acknowledged') DESC,
               a.severity DESC,
               a.created_at ASC
      LIMIT $3`,
    [status || null, severity || null, limit],
  );
  return rows;
}

async function alertCounts() {
  const { rows } = await pool.query(
    `SELECT status::text AS status, COUNT(*)::int AS n
       FROM crisis_alerts GROUP BY status`,
  );
  const counts = { new: 0, acknowledged: 0, resolved: 0, false_positive: 0, all: 0 };
  rows.forEach((r) => {
    counts[r.status] = r.n;
    counts.all += r.n;
  });
  // Unresolved + high severity is the number that actually matters on a
  // support shift, so it gets computed separately rather than derived.
  const { rows: urgent } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM crisis_alerts
      WHERE status IN ('new','acknowledged') AND (severity >= 4 OR is_minor)`,
  );
  counts.urgent = urgent[0] ? urgent[0].n : 0;
  return counts;
}

async function getAlert(alertId) {
  const { rows } = await pool.query(
    `SELECT a.*, cp.full_name, k.phrase AS matched_phrase,
            assignee.email AS assigned_email
       FROM crisis_alerts a
       JOIN client_profiles cp ON cp.user_id = a.user_id
       LEFT JOIN crisis_keywords k ON k.id = a.matched_keyword_id
       LEFT JOIN users assignee ON assignee.id = a.assigned_to
      WHERE a.id = $1`,
    [alertId],
  );
  return rows[0] || null;
}

async function listAlertsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.severity, a.status, a.trigger_type, a.is_minor, a.created_at,
            a.acknowledged_at, a.resolved_at, a.resolution_notes,
            a.source_table, a.source_message_id,
            k.phrase AS matched_phrase, assignee.email AS assigned_email
       FROM crisis_alerts a
       LEFT JOIN crisis_keywords k ON k.id = a.matched_keyword_id
       LEFT JOIN users assignee ON assignee.id = a.assigned_to
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Status transitions all funnel through here so the timestamp columns can
 * never drift out of sync with the status enum.
 */
async function updateAlertStatus({ alertId, status, agentId, notes }) {
  const { rows } = await pool.query(
    `UPDATE crisis_alerts
        SET status = $2::crisis_alert_status,
            assigned_to = COALESCE(assigned_to, $3::uuid),
            resolution_notes = COALESCE(NULLIF($4::text, ''), resolution_notes),
            acknowledged_at = CASE
              WHEN $2::text IN ('acknowledged','resolved','false_positive')
                THEN COALESCE(acknowledged_at, now())
              ELSE acknowledged_at END,
            resolved_at = CASE
              WHEN $2::text IN ('resolved','false_positive') THEN COALESCE(resolved_at, now())
              WHEN $2::text = 'new' THEN NULL
              ELSE resolved_at END
      WHERE id = $1
      RETURNING id, user_id, status::text AS status`,
    [alertId, status, agentId, notes || ''],
  );
  return rows[0] || null;
}

async function claimAlert({ alertId, agentId }) {
  const { rows } = await pool.query(
    `UPDATE crisis_alerts SET assigned_to = $2::uuid WHERE id = $1
      RETURNING id, user_id`,
    [alertId, agentId],
  );
  return rows[0] || null;
}

// ------------------------------------------------------ flagged content ---

/**
 * Resolves the content that actually tripped the alert.
 *
 * The privacy rule for this whole module: support sees the flagged item and
 * its immediate conversation, never the client's wider history. For an AI
 * chat that means the one conversation the flagged message belongs to; for
 * a journal entry it means that single entry and nothing else, since
 * journal entries have no thread to give context.
 */
async function getFlaggedContent({ userId, sourceTable, sourceMessageId }) {
  if (!sourceMessageId) return { kind: null, messages: [], entry: null };

  if (sourceTable === 'ai_messages') {
    const { rows: owned } = await pool.query(
      `SELECT m.conversation_id
         FROM ai_messages m
         JOIN ai_conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND c.user_id = $2`,
      [sourceMessageId, userId],
    );
    if (!owned[0]) return { kind: 'ai_messages', messages: [], entry: null };
    const { rows } = await pool.query(
      `SELECT id, sender::text AS sender, content, created_at
         FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [owned[0].conversation_id],
    );
    return { kind: 'ai_messages', messages: rows, entry: null };
  }

  if (sourceTable === 'journal_entries') {
    const { rows } = await pool.query(
      `SELECT id, title, content, mood_tag, created_at
         FROM journal_entries
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [sourceMessageId, userId],
    );
    return { kind: 'journal_entries', messages: [], entry: rows[0] || null };
  }

  return { kind: sourceTable || null, messages: [], entry: null };
}

// --------------------------------------------------------------- client ---

async function getClient(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.phone, u.status::text AS status, u.created_at,
            cp.full_name, cp.date_of_birth, cp.preferred_language, cp.timezone,
            cp.subscription_tier, cp.guardian_consent_completed_at,
            date_part('year', age(cp.date_of_birth))::int AS age,
            o.company_name AS org_name
       FROM users u
       JOIN client_profiles cp ON cp.user_id = u.id
       LEFT JOIN organization_employees oe ON oe.user_id = u.id
       LEFT JOIN organizations o ON o.id = oe.org_id
      WHERE u.id = $1
      LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Support-side client lookup. Needed because wellness reporting and mood
 * review aren't always reached from an alert — an agent following up on a
 * case has to be able to find the client by name or email.
 */
async function searchClients({ search, limit = 50 }) {
  const term = search ? `%${search}%` : null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.phone, cp.full_name, cp.subscription_tier,
            (SELECT MAX(r.response_date) FROM survey_responses r WHERE r.user_id = u.id)
              AS last_checkin,
            (SELECT COUNT(*)::int FROM crisis_alerts a
              WHERE a.user_id = u.id AND a.status IN ('new','acknowledged')) AS open_alerts
       FROM users u
       JOIN client_profiles cp ON cp.user_id = u.id
      WHERE u.role = 'client' AND u.deleted_at IS NULL
        AND ($1::text IS NULL
             OR cp.full_name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1)
      ORDER BY open_alerts DESC, cp.full_name ASC
      LIMIT $2`,
    [term, limit],
  );
  return rows;
}

// ----------------------------------------------------------------- mood ---

/**
 * Mood tracking is the daily check-in survey: survey_responses (one row per
 * user per day) -> survey_answers -> survey_questions. Slider questions are
 * the trendable part; select questions are categorical and get shown as
 * option text.
 *
 * Slider ranges differ per question (slider_min/slider_max), so nothing here
 * assumes a 1-10 scale — values are normalized to a percentage before they
 * reach the chart.
 */
async function getMoodHistory({ userId, days = 60 }) {
  const { rows } = await pool.query(
    `SELECT r.id AS response_id, to_char(r.response_date, 'YYYY-MM-DD') AS response_date,
            r.completed_at,
            q.id AS question_id, q.question_text, q.question_type::text AS question_type,
            q.order_index, q.slider_min, q.slider_max,
            q.slider_min_label, q.slider_max_label,
            a.slider_value, a.selected_option_ids, a.answered_at
       FROM survey_responses r
       LEFT JOIN survey_answers a ON a.response_id = r.id
       LEFT JOIN survey_questions q ON q.id = a.question_id
      WHERE r.user_id = $1
        AND r.response_date >= CURRENT_DATE - ($2::int || ' days')::interval
      ORDER BY r.response_date DESC, q.order_index ASC`,
    [userId, days],
  );

  // Resolve option ids -> text in one round trip rather than per answer.
  const optionIds = [];
  rows.forEach((r) => (r.selected_option_ids || []).forEach((id) => optionIds.push(id)));
  let optionsById = {};
  if (optionIds.length) {
    const { rows: opts } = await pool.query(
      `SELECT id, option_text, emoji FROM survey_question_options WHERE id = ANY($1::uuid[])`,
      [[...new Set(optionIds)]],
    );
    opts.forEach((o) => (optionsById[o.id] = o));
  }

  // Group flat rows into one entry per check-in day.
  const byDate = new Map();
  rows.forEach((r) => {
    const key = r.response_date; // already 'YYYY-MM-DD' text from SQL
    if (!byDate.has(key)) {
      byDate.set(key, { date: key, completedAt: r.completed_at, answers: [] });
    }
    if (!r.question_id) return; // check-in row with no answers yet
    byDate.get(key).answers.push({
      questionId: r.question_id,
      questionText: r.question_text,
      questionType: r.question_type,
      orderIndex: r.order_index,
      sliderValue: r.slider_value,
      sliderMin: r.slider_min,
      sliderMax: r.slider_max,
      sliderMinLabel: r.slider_min_label,
      sliderMaxLabel: r.slider_max_label,
      options: (r.selected_option_ids || []).map((id) => optionsById[id]).filter(Boolean),
    });
  });

  return [...byDate.values()];
}

/**
 * Builds one chart series per slider question, oldest -> newest, with values
 * normalized to 0-100 so questions on different scales can share an axis.
 */
function buildMoodSeries(history) {
  const series = new Map();
  [...history].reverse().forEach((day) => {
    day.answers
      .filter((a) => a.questionType === 'slider' && a.sliderValue !== null)
      .forEach((a) => {
        if (!series.has(a.questionId)) {
          series.set(a.questionId, {
            questionId: a.questionId,
            label: a.questionText,
            min: a.sliderMin,
            max: a.sliderMax,
            minLabel: a.sliderMinLabel,
            maxLabel: a.sliderMaxLabel,
            points: [],
          });
        }
        const s = series.get(a.questionId);
        const span = (a.sliderMax ?? 10) - (a.sliderMin ?? 0) || 1;
        s.points.push({
          date: day.date,
          value: a.sliderValue,
          pct: ((a.sliderValue - (a.sliderMin ?? 0)) / span) * 100,
        });
      });
  });

  return [...series.values()].map((s) => {
    const vals = s.points.map((p) => p.value);
    const recent = s.points.slice(-7);
    const prior = s.points.slice(-14, -7);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const recentAvg = avg(recent.map((p) => p.value));
    const priorAvg = avg(prior.map((p) => p.value));
    return {
      ...s,
      latest: vals.length ? vals[vals.length - 1] : null,
      average: vals.length ? avg(vals) : null,
      recentAvg,
      // Null when there's no prior week to compare against — an unknown
      // trend shouldn't render as "flat".
      delta: recentAvg !== null && priorAvg !== null ? recentAvg - priorAvg : null,
    };
  });
}

async function getJournalMoodTags({ userId, days = 60 }) {
  // Tags only — never entry content. Journal text is private to the client
  // and their provider; the only exception is a single entry that itself
  // triggered a crisis alert, handled in getFlaggedContent above.
  const { rows } = await pool.query(
    `SELECT mood_tag, COUNT(*)::int AS n, MAX(created_at) AS last_at
       FROM journal_entries
      WHERE user_id = $1 AND deleted_at IS NULL AND mood_tag IS NOT NULL
        AND created_at >= now() - ($2::int || ' days')::interval
      GROUP BY mood_tag
      ORDER BY n DESC`,
    [userId, days],
  );
  return rows;
}

async function getCheckinStreak(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS last_30,
            MAX(response_date) AS last_date
       FROM survey_responses
      WHERE user_id = $1 AND response_date >= CURRENT_DATE - INTERVAL '30 days'`,
    [userId],
  );
  return rows[0] || { last_30: 0, last_date: null };
}

// ------------------------------------------------------------- wellness ---

async function listWellnessReports(userId) {
  const { rows } = await pool.query(
    `SELECT w.id, w.title, w.summary, w.report_period_start, w.report_period_end,
            w.metrics, w.file_url, w.is_visible_to_client, w.created_at,
            author.email AS created_by_email
       FROM wellness_reports w
       LEFT JOIN users author ON author.id = w.created_by
      WHERE w.client_id = $1
      ORDER BY w.report_period_start DESC`,
    [userId],
  );
  return rows;
}

async function createWellnessReport({
  clientId, title, summary, periodStart, periodEnd, metrics, fileUrl, createdBy, visible,
}) {
  const { rows } = await pool.query(
    `INSERT INTO wellness_reports
       (client_id, title, summary, report_period_start, report_period_end,
        metrics, file_url, created_by, is_visible_to_client)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING id`,
    [
      clientId, title, summary || null, periodStart, periodEnd,
      JSON.stringify(metrics || {}), fileUrl || null, createdBy, visible,
    ],
  );
  return rows[0];
}

async function setReportVisibility({ reportId, visible }) {
  const { rows } = await pool.query(
    `UPDATE wellness_reports SET is_visible_to_client = $2 WHERE id = $1
      RETURNING id, client_id`,
    [reportId, visible],
  );
  return rows[0] || null;
}

/**
 * Pre-fills the metrics jsonb of a new report from the check-in data that's
 * already on file, so an agent isn't retyping numbers the DB already knows.
 */
function summarizeMetrics({ series, history, journalTags }) {
  const metrics = {
    checkins_in_period: history.length,
    sliders: series.map((s) => ({
      question: s.label,
      latest: s.latest,
      average: s.average === null ? null : Number(s.average.toFixed(2)),
      recent_7d_average: s.recentAvg === null ? null : Number(s.recentAvg.toFixed(2)),
      trend: s.delta === null ? 'unknown' : s.delta > 0.25 ? 'up' : s.delta < -0.25 ? 'down' : 'flat',
      scale: `${s.min ?? 0}-${s.max ?? 10}`,
    })),
    journal_mood_tags: journalTags.map((t) => ({ tag: t.mood_tag, count: t.n })),
  };
  return metrics;
}

module.exports = {
  logSupportAction,
  listAlerts,
  alertCounts,
  getAlert,
  listAlertsForUser,
  updateAlertStatus,
  claimAlert,
  getFlaggedContent,
  getClient,
  searchClients,
  getMoodHistory,
  buildMoodSeries,
  getJournalMoodTags,
  getCheckinStreak,
  listWellnessReports,
  createWellnessReport,
  setReportVisibility,
  summarizeMetrics,
};
