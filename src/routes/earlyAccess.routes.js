const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { uuidParams, sanitizeSearch } = require('../lib/validate');
const E = require('../lib/earlyAccess');

// Early-access waitlists (features not live yet): a follow-up queue per
// feature, demand by city, CSV export, and a plain list of what we store.
// Customer answers are read-only here; only the follow-up columns change.

const router = express.Router();
router.use(requireSuperAdmin);
uuidParams(router, ['entryId'], '/early-access', 'Back to early access');

router.use((req, res, next) => {
  res.locals.E = E;
  next();
});

const STATUS_VALUES = E.STATUSES.map((s) => s.value);

const notFound = (res) =>
  res.status(404).render('errors/404', { layout: false, backHref: '/early-access', backLabel: 'Back to early access' });

function featureOr404(req, res) {
  const feature = E.FEATURES[req.params.feature];
  if (!feature) notFound(res);
  return feature;
}

/** Query-string filters → { filters, apply(query) }. Unknown values are dropped. */
function readFilters(feature, q) {
  const f = {
    status: STATUS_VALUES.includes(q.status) ? q.status : 'open',
    q: sanitizeSearch(q.q),
  };
  Object.keys(feature.options).forEach((col) => {
    if (feature.options[col].some((o) => o.value === q[col])) f[col] = q[col];
  });
  const apply = (query) => {
    if (f.status === 'open') query = query.in('status', ['new', 'contacted', 'follow_up']);
    else if (f.status !== 'all') query = query.eq('status', f.status);
    Object.keys(feature.options).forEach((col) => {
      if (f[col]) query = query.eq(col, f[col]);
    });
    if (f.q) query = query.or(`name.ilike.%${f.q}%,contact.ilike.%${f.q}%,city.ilike.%${f.q}%,state.ilike.%${f.q}%`);
    return query;
  };
  if (q.status === 'all') f.status = 'all';
  return { filters: f, apply };
}

router.get('/', (req, res) => res.redirect('/early-access/physiotherapy'));

// ------------------------------------------------------------------ queue ---

router.get('/:feature', async (req, res) => {
  const feature = featureOr404(req, res);
  if (!feature) return;
  const { filters, apply } = readFilters(feature, req.query);

  const [{ data: rows, error }, { data: all, error: allErr }] = await Promise.all([
    apply(supabase.from(feature.table).select('*')).order('created_at', { ascending: true }).limit(500),
    supabase.from(feature.table).select('status, city, state, price_fit, timing'),
  ]);
  if (error || allErr) throw new Error(`Could not load the waitlist — ${(error || allErr).message}`);

  const counts = { all: all.length, open: 0 };
  E.STATUSES.forEach((s) => (counts[s.value] = 0));
  const cities = {};
  let priceYes = 0;
  let soon = 0;
  all.forEach((r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (['new', 'contacted', 'follow_up'].includes(r.status)) counts.open += 1;
    if (r.price_fit === 'yes') priceYes += 1;
    if (['asap', 'within_month'].includes(r.timing)) soon += 1;
    const key = `${(r.city || '').trim().toLowerCase()}|${(r.state || '').trim().toLowerCase()}`;
    if (!cities[key]) cities[key] = { city: (r.city || '').trim(), state: (r.state || '').trim(), total: 0, priceYes: 0 };
    cities[key].total += 1;
    if (r.price_fit === 'yes') cities[key].priceYes += 1;
  });
  const topCities = Object.values(cities).sort((a, b) => b.total - a.total).slice(0, 10);

  res.render('earlyAccess/index', {
    feature,
    filters,
    counts,
    rows: rows || [],
    stats: { total: all.length, open: counts.open, priceYes, soon },
    topCities,
    query: req.query,
  });
});

// ------------------------------------------------------------------- CSV ---

router.get('/:feature/export.csv', async (req, res) => {
  const feature = featureOr404(req, res);
  if (!feature) return;
  const { filters, apply } = readFilters(feature, req.query);
  const { data: rows, error } = await apply(supabase.from(feature.table).select('*')).order('created_at', { ascending: true });
  if (error) throw new Error(`Could not export — ${error.message}`);

  const cols = feature.fields.map((f) => f.col);
  const lines = [cols.map(E.csvCell).join(',')];
  (rows || []).forEach((r) => {
    lines.push(cols.map((c) => E.csvCell(feature.fields.find((f) => f.col === c).option ? E.labelOf(feature, c, r[c]) : r[c])).join(','));
  });

  // Contains personal contact details — leave a trail.
  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'early_access.exported',
    targetTable: feature.table,
    targetId: req.session.superAdmin.id,
    details: { feature: feature.key, rows: (rows || []).length, filters },
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${feature.key}-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

// ---------------------------------------------------------------- detail ---

router.get('/:feature/:entryId', async (req, res) => {
  const feature = featureOr404(req, res);
  if (!feature) return;
  const { data: entry, error } = await supabase.from(feature.table).select('*').eq('id', req.params.entryId).maybeSingle();
  if (error) throw new Error(`Could not load the entry — ${error.message}`);
  if (!entry) return notFound(res);

  const ids = [entry.user_id, entry.handled_by].filter(Boolean);
  const { data: people } = ids.length ? await supabase.from('users').select('id, email, phone, role, status').in('id', ids) : { data: [] };
  const byId = {};
  (people || []).forEach((p) => (byId[p.id] = p));

  res.render('earlyAccess/show', { feature, entry, account: byId[entry.user_id] || null, handler: byId[entry.handled_by] || null });
});

router.post('/:feature/:entryId', async (req, res) => {
  const feature = featureOr404(req, res);
  if (!feature) return;
  const back = `/early-access/${feature.key}/${req.params.entryId}`;
  const status = String(req.body.status || '');
  const note = String(req.body.staff_note || '').trim().slice(0, 2000) || null;
  if (!STATUS_VALUES.includes(status)) {
    req.setFlash({ type: 'error', message: 'Choose a valid status.' });
    return res.redirect(back);
  }

  const { data: before } = await supabase.from(feature.table).select('status, contacted_at').eq('id', req.params.entryId).maybeSingle();
  if (!before) return notFound(res);

  const patch = { status, staff_note: note, handled_by: req.session.superAdmin.id };
  if (status !== 'new' && !before.contacted_at) patch.contacted_at = new Date().toISOString();
  const { error } = await supabase.from(feature.table).update(patch).eq('id', req.params.entryId);
  if (error) throw new Error(`Could not save — ${error.message}`);

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'early_access.follow_up',
    targetTable: feature.table,
    targetId: req.params.entryId,
    details: { from: before.status, to: status, note_set: !!note },
  });
  req.setFlash({ type: 'success', message: `Saved — status is now “${E.labelOf(feature, 'status', status)}”.` });
  res.redirect(back);
});

module.exports = router;
