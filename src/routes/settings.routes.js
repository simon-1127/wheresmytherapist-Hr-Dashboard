const express = require('express');
const { supabase } = require('../config/supabase');
const { pool } = require('../config/db');
const { mailerStatus } = require('../config/mailer');
const { requireSuperAdmin } = require('../middleware/auth');
const { sanitizeSearch, dashboardUrl } = require('../lib/validate');

// "System & audit log". Team management moved to /team. This page answers
// two questions without opening Railway or the SQL editor:
//   1. Is everything this dashboard depends on actually working?
//   2. Who did what, when?

const router = express.Router();
router.use(requireSuperAdmin);

const PAGE_SIZE = 50;

async function checks() {
  const out = [];

  const t0 = Date.now();
  try {
    const { error } = await supabase.from('subscription_tiers').select('id', { head: true, count: 'exact' });
    out.push({ name: 'Supabase API', ok: !error, detail: error ? error.message : `${Date.now() - t0} ms` });
  } catch (err) {
    out.push({ name: 'Supabase API', ok: false, detail: err.message });
  }

  if (!process.env.DATABASE_URL) {
    out.push({ name: 'Postgres (support console)', ok: false, detail: 'DATABASE_URL is not set — /support pages will fail.' });
  } else {
    const t1 = Date.now();
    try {
      await pool.query('select 1');
      out.push({ name: 'Postgres (support console)', ok: true, detail: `${Date.now() - t1} ms` });
    } catch (err) {
      out.push({ name: 'Postgres (support console)', ok: false, detail: err.message || err.code });
    }
  }

  const m = mailerStatus();
  out.push({
    name: 'Email (SMTP)',
    ok: m.configured && m.verified !== false,
    detail: !m.configured
      ? 'SMTP_HOST not set — emails are only logged, never sent.'
      : m.verified === false
        ? `Connection check failed: ${m.lastError}`
        : `${m.host}:${m.port} as ${m.from || '(MAIL_FROM not set)'}` +
          (m.lastErrorAt ? ` · last send error ${new Date(m.lastErrorAt).toLocaleString('en-IN')}: ${m.lastError}` : ''),
  });

  // Accounts in public.users whose Supabase auth user no longer exists.
  // They can't log in, and signing up again with the same email fails with
  // "Database error saving new user" (users.email is UNIQUE). Needs the
  // direct Postgres connection, since auth.users isn't exposed over the API.
  if (process.env.DATABASE_URL) {
    try {
      const { rows } = await pool.query(
        `SELECT u.email, u.role::text AS role
           FROM public.users u
           LEFT JOIN auth.users a ON a.id = u.id
          WHERE a.id IS NULL AND u.status <> 'deleted'
          ORDER BY u.created_at DESC
          LIMIT 20`,
      );
      out.push({
        name: 'Accounts without a login',
        ok: rows.length === 0,
        detail: rows.length
          ? `${rows.length} active account(s) have no Supabase auth user: ${rows.map((r) => `${r.email} (${r.role})`).join(', ')}. ` +
            'They cannot log in or re-register. Mark them deleted under Users, or remove the rows in SQL.'
          : 'None',
      });
    } catch (err) {
      out.push({ name: 'Accounts without a login', ok: true, detail: `Skipped — ${err.message}` });
    }
  }

  const be = require('../lib/backend').config();
  out.push({
    name: 'Backend admin API (sessions & refunds)',
    ok: be.ready,
    detail: be.ready ? be.base : 'WMT_BACKEND_URL and/or ADMIN_INTERNAL_API_KEY not set — the Sessions evidence, review queue and refunds pages will show an error.',
  });

  out.push({
    name: 'Session secret',
    ok: Boolean(process.env.SESSION_SECRET),
    detail: process.env.SESSION_SECRET ? 'Set' : 'SESSION_SECRET not set — a derived key is being used. Set it in Railway.',
  });

  const urlSet = Boolean(process.env.DASHBOARD_URL || process.env.SUPPORT_DASHBOARD_URL);
  out.push({
    name: 'Dashboard URL (for email links)',
    ok: urlSet,
    detail: urlSet ? dashboardUrl() : `Not set — emails link to ${dashboardUrl()}. Set DASHBOARD_URL to be explicit.`,
  });

  out.push({
    name: 'Employee magic-link redirect',
    ok: Boolean(process.env.EMPLOYEE_REDIRECT_URL),
    detail: process.env.EMPLOYEE_REDIRECT_URL || 'EMPLOYEE_REDIRECT_URL not set — employee invite links will land on the Supabase default.',
  });

  return out;
}

router.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const action = sanitizeSearch(req.query.action);

  let q = supabase
    .from('admin_audit_log')
    .select('id, admin_id, action, target_table, target_id, details, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (action) q = q.ilike('action', `%${action}%`);

  const [{ data: log, count, error }, health] = await Promise.all([q, checks()]);
  if (error) req.setFlash({ type: 'error', message: 'Could not load the audit log — ' + error.message });

  const adminIds = [...new Set((log || []).map((l) => l.admin_id).filter(Boolean))];
  let emailOf = {};
  if (adminIds.length) {
    const { data: admins } = await supabase.from('users').select('id, email').in('id', adminIds);
    emailOf = Object.fromEntries((admins || []).map((a) => [a.id, a.email]));
  }

  res.render('settings/index', {
    title: 'System',
    health,
    log: (log || []).map((l) => ({ ...l, by: emailOf[l.admin_id] || null })),
    page,
    pages: Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)),
    action,
  });
});

module.exports = router;
