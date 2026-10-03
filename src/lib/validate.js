// Small input guards shared by every router. Each one exists because its
// absence produced a real failure mode — see the notes per function.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * A malformed id in the URL (a truncated link from an email, a typo) used to
 * reach Postgres as-is and come back as a 22P02 "invalid input syntax for
 * type uuid" 500 page. Registering this on a router turns that into a clean
 * 404 before any query runs.
 */
function uuidParams(router, names, backHref, backLabel) {
  names.forEach((name) => {
    router.param(name, (req, res, next, value) => {
      if (isUuid(value)) return next();
      return res.status(404).render('errors/404', { layout: false, backHref, backLabel });
    });
  });
}

/**
 * Only same-site relative paths. Several forms post a `redirect` field back
 * to the server; trusting it verbatim is an open redirect (`//evil.com`
 * is a valid Location header).
 */
function safeRedirect(target, fallback) {
  if (typeof target !== 'string') return fallback;
  if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return fallback;
  return target;
}

/**
 * Supabase stores auth emails lowercased, and the DB trigger that links an
 * invited employee to their account compares emails with plain `=`. An
 * employee typed in as "Priya@Acme.com" therefore never linked and never got
 * the org tier. Everything that writes an email goes through this.
 */
function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

// Deliberately loose — the point is to catch "priya@acme" and pasted
// spreadsheet junk, not to re-implement RFC 5322.
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// For values interpolated into outgoing email HTML.
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// For PostgREST ilike patterns built from user input.
function escapeLike(v) {
  return String(v || '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * PostgREST's `.or()` takes a comma/parenthesis-delimited filter string, so a
 * search term containing those characters breaks the whole query (and shows
 * up as "nothing found"). Strip them rather than try to quote.
 */
function sanitizeSearch(v) {
  return String(v || '').replace(/[,()*%\\]/g, ' ').trim().slice(0, 100);
}

// Provider-controlled URLs (photo, intro video) are rendered as links in
// this admin UI. Anything that isn't plain http(s) — `javascript:` in
// particular — would run in a super admin's session when clicked.
function safeUrl(v) {
  if (typeof v !== 'string') return null;
  return /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
}

// Public base URL of this dashboard, for links inside emails.
function dashboardUrl() {
  return (
    process.env.DASHBOARD_URL ||
    process.env.SUPPORT_DASHBOARD_URL ||
    'https://hr.wheresmytherapist.com'
  ).replace(/\/+$/, '');
}

module.exports = {
  isUuid,
  uuidParams,
  safeRedirect,
  normalizeEmail,
  isEmail,
  escapeHtml,
  escapeLike,
  sanitizeSearch,
  dashboardUrl,
  safeUrl,
};
