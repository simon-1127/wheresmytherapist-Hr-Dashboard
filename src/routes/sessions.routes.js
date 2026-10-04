const express = require('express');
const { requireStaff } = require('../middleware/auth');
const backend = require('../lib/backend');
const q = require('../lib/sessionQueries');
const { sign, verify, consumeNonce } = require('../lib/signing');
const { uuidParams } = require('../lib/validate');
const P = require('../lib/sessionPolicy');

// Sessions & Refunds. Reads for search/audit go straight to Postgres; every
// read of evidence and every change goes through the backend admin API,
// which re-checks the admin's role and writes its own audit entries.

const router = express.Router();
router.use(requireStaff);
uuidParams(router, ['id', 'refundId', 'snapshotId'], '/sessions', 'Back to sessions');

// Shared view helpers for every page in this section.
router.use((req, res, next) => {
  Object.assign(res.locals, {
    inr: P.inr,
    can: (action) => P.can(req.viewer.role, action),
    P,
  });
  next();
});

function requirePerm(action) {
  return (req, res, next) => {
    if (P.can(req.viewer.role, action)) return next();
    req.setFlash({ type: 'error', message: "Your role can't do that." });
    return res.redirect(req.params.id ? `/sessions/${req.params.id}` : '/sessions');
  };
}

/** Backend list endpoints may return a bare array or wrap it. */
function asList(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const k of [...keys, 'items', 'data', 'results']) {
    if (data && Array.isArray(data[k])) return data[k];
  }
  return [];
}

const MIN_NOTE = 5;
const cleanNote = (v) => String(v || '').trim().slice(0, 2000);

// --------------------------------------------------------------- search ---

router.get('/', async (req, res) => {
  const f = {
    q: String(req.query.q || '').trim().slice(0, 120),
    status: P.SESSION_STATUS[req.query.status] ? req.query.status : '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '',
    user: q.UUID_RE.test(req.query.user || '') ? req.query.user : '',
  };

  // A pasted full session id goes straight to its evidence page.
  if (q.UUID_RE.test(f.q) && !f.status && !f.from && !f.to && !f.user) {
    const hit = await q.searchSessions({ q: f.q, limit: 2 });
    if (hit.length === 1 && hit[0].id === f.q.toLowerCase()) return res.redirect(`/sessions/${hit[0].id}`);
  }

  const searched = Boolean(f.q || f.status || f.from || f.to || f.user);
  const rows = await q.searchSessions({
    q: f.q,
    status: f.status,
    from: f.from,
    to: f.to,
    userId: f.user,
    limit: searched ? 100 : 30,
  });

  let userLabel = null;
  if (f.user) {
    const { client } = await q.parties(f.user, null);
    userLabel = client ? client.full_name || client.email : f.user;
  }

  res.render('sessions/index', { title: 'Sessions', rows, f, searched, userLabel });
});

// --------------------------------------------------------- review queue ---

router.get('/review', async (req, res) => {
  const r = await backend.reviewQueue(req.viewer.id, 200);
  const all = r.ok ? asList(r.data, 'sessions', 'queue') : [];

  // Field names normalised once here so the template doesn't guess.
  const items = all.map((x) => {
    const s = x.session || x;
    return {
      id: x.session_id || s.id,
      status: s.status,
      fault: s.fault,
      scheduled_start: s.scheduled_start,
      review_reason: x.review_reason || s.review_reason || '—',
      settlement_status: x.settlement_status || (x.settlement && x.settlement.status) || null,
      client_name: x.client_name || (x.client && (x.client.full_name || x.client.email)) || '—',
      provider_name: x.provider_name || (x.provider && (x.provider.full_name || x.provider.email)) || '—',
      amount: s.amount,
    };
  });

  const reasons = [...new Set(items.map((i) => i.review_reason))].sort();
  const f = {
    reason: reasons.includes(req.query.reason) ? req.query.reason : '',
    settlement: String(req.query.settlement || ''),
    q: String(req.query.q || '').trim().toLowerCase(),
  };
  const filtered = items.filter(
    (i) =>
      (!f.reason || i.review_reason === f.reason) &&
      (!f.settlement || (i.settlement_status || 'none') === f.settlement) &&
      (!f.q || [i.id, i.client_name, i.provider_name].some((v) => String(v || '').toLowerCase().includes(f.q))),
  );

  res.render('sessions/review', {
    title: 'Review queue',
    error: r.ok ? null : r.message,
    items: filtered,
    total: items.length,
    reasons,
    f,
  });
});

// -------------------------------------------------------------- refunds ---

router.get('/refunds', async (req, res) => {
  const status = P.REFUND_STATUSES.includes(req.query.status) ? req.query.status : '';
  const r = await backend.refunds(req.viewer.id, status || undefined, 200);
  const refunds = r.ok ? asList(r.data, 'refunds') : [];
  const actors = await q.emailsFor(refunds.map((x) => x.initiated_by)).catch(() => ({}));
  res.render('sessions/refunds', {
    title: 'Refunds',
    error: r.ok ? null : r.message,
    refunds,
    actors,
    status,
  });
});

router.post('/refunds/:refundId/retry', requirePerm('retry'), async (req, res) => {
  const r = await backend.retryRefund(req.viewer.id, req.params.refundId);
  if (!r.ok) {
    req.setFlash({ type: 'error', message: `Retry failed: ${r.message}` });
  } else {
    const st = r.data && (r.data.status || (r.data.refund && r.data.refund.status));
    req.setFlash({
      type: st === 'failed' ? 'error' : 'success',
      message: st === 'failed'
        ? `Razorpay rejected it again: ${(r.data && (r.data.last_error || (r.data.refund && r.data.refund.last_error))) || 'no reason given'}`
        : `Refund retried${st ? ` — now ${st}` : ''}.`,
    });
  }
  const back = req.body.session_id && q.UUID_RE.test(req.body.session_id) ? `/sessions/${req.body.session_id}` : '/sessions/refunds?status=failed';
  res.redirect(back);
});

// ------------------------------------------------------------ snapshots ---

router.get('/snapshots/:snapshotId', async (req, res) => {
  const r = await backend.snapshot(req.viewer.id, req.params.snapshotId);
  if (!r.ok && r.status === 404) return res.status(404).render('errors/404', { layout: false, backHref: '/sessions', backLabel: 'Back to sessions' });
  res.render('sessions/snapshot', { title: 'Evidence snapshot', error: r.ok ? null : r.message, snap: r.ok ? r.data : null });
});

// ------------------------------------------------------- evidence page ---

async function loadEvidence(req, id) {
  const [ev, summary] = await Promise.all([
    backend.evidence(req.viewer.id, id),
    q.searchSessions({ q: id, limit: 1 }).then((rows) => rows.find((x) => x.id === id) || null).catch(() => null),
  ]);
  return { ev, summary };
}

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const { ev, summary } = await loadEvidence(req, id);

  // Unknown to both the backend and the DB -> plain 404. If only the
  // backend failed, still render what the DB knows plus the backend's
  // message, so an outage doesn't hide the session entirely.
  if (!ev.ok && !summary && ev.status === 404) {
    return res.status(404).render('errors/404', { layout: false, backHref: '/sessions', backLabel: 'Back to sessions' });
  }

  const e = ev.ok ? ev.data || {} : {};
  const session = { ...(summary || {}), ...(e.session || {}) };
  const clientId = session.client_id;
  const providerId = session.provider_id;

  const refunds = e.refunds || [];
  const snapshots = e.snapshots || [];
  const timeline = [...(e.timeline || [])].sort((a, b) => new Date(a.at) - new Date(b.at));

  const [people, audit] = await Promise.all([
    q.parties(clientId, providerId).catch(() => ({ client: null, provider: null })),
    q.auditForSession(id, refunds.map((r) => r.id)).catch(() => []),
  ]);
  const actorIds = [
    session.outcome_decided_by,
    ...refunds.map((r) => r.initiated_by),
    ...(e.settlements || []).map((s) => s.decided_by),
    ...snapshots.map((s) => s.created_by),
    ...(e.reschedules || []).map((s) => s.initiated_by),
  ];
  const actors = await q.emailsFor(actorIds).catch(() => ({}));

  const attendance = {};
  (e.attendance || []).forEach((a) => (attendance[a.role] = a));

  res.render('sessions/show', {
    title: `Session ${id.slice(0, 8)}`,
    id,
    error: ev.ok ? null : ev.message,
    session,
    people,
    attendance,
    intervals: e.intervals || [],
    timeline,
    rooms: e.rooms || [],
    chain: e.chain || [],
    reschedules: e.reschedules || [],
    payments: e.payments || [],
    refunds,
    settlements: e.settlements || [],
    refundable: Number.isFinite(Number(e.refundable_amount)) ? Number(e.refundable_amount) : null,
    snapshots,
    audit,
    actors,
    roleOf: (uid) => (uid && uid === clientId ? 'client' : uid && uid === providerId ? 'provider' : null),
  });
});

// --------------------------------------------------------------- refund ---
// Two steps. /refund/review validates and shows the exact amount; /refund
// sends only what the signed token says.

router.post('/:id/refund/review', requirePerm('refund'), async (req, res) => {
  const { id } = req.params;
  const back = `/sessions/${id}#refund`;
  const full = req.body.mode !== 'partial';
  const reason = req.body.reason_category;
  const note = cleanNote(req.body.note);
  const providerLiable = req.body.provider_liable === 'on';

  if (!P.REFUND_REASONS.some((r) => r.value === reason)) {
    req.setFlash({ type: 'error', message: 'Pick a refund reason.' });
    return res.redirect(back);
  }
  if (note.length < MIN_NOTE) {
    req.setFlash({ type: 'error', message: `Add a note of at least ${MIN_NOTE} characters — it's kept with the refund.` });
    return res.redirect(back);
  }

  // Re-read the cap now rather than trusting the page, which may be stale.
  const ev = await backend.evidence(req.viewer.id, id);
  if (!ev.ok) {
    req.setFlash({ type: 'error', message: `Could not load the session: ${ev.message}` });
    return res.redirect(back);
  }
  const refundable = Number(ev.data && ev.data.refundable_amount);
  if (!Number.isFinite(refundable) || refundable <= 0) {
    req.setFlash({ type: 'error', message: 'Nothing left to refund on this session.' });
    return res.redirect(back);
  }

  let amount = refundable;
  if (!full) {
    amount = P.rupeesToPaise(req.body.amount_rupees);
    if (!amount || amount <= 0) {
      req.setFlash({ type: 'error', message: 'Enter a partial amount in rupees, e.g. 250 or 250.50.' });
      return res.redirect(back);
    }
    if (amount > refundable) {
      req.setFlash({ type: 'error', message: `That's more than the refundable ${P.inr(refundable)}.` });
      return res.redirect(back);
    }
    if (amount === refundable) {
      // Same money either way; record it as what it is.
      return renderConfirm(req, res, { id, full: true, amount, refundable, reason, note, providerLiable, ev: ev.data });
    }
  }
  return renderConfirm(req, res, { id, full, amount, refundable, reason, note, providerLiable, ev: ev.data });
});

async function renderConfirm(req, res, { id, full, amount, refundable, reason, note, providerLiable, ev }) {
  const s = (ev && ev.session) || {};
  const people = await q.parties(s.client_id, s.provider_id).catch(() => ({ client: null, provider: null }));
  const token = sign({ sid: id, full, amount, reason, note, providerLiable });
  res.render('sessions/refundConfirm', {
    title: 'Confirm refund',
    id,
    full,
    amount,
    refundable,
    reason,
    note,
    providerLiable,
    session: s,
    people,
    token,
  });
}

router.post('/:id/refund', requirePerm('refund'), async (req, res) => {
  const { id } = req.params;
  const back = `/sessions/${id}`;
  const v = verify(req.body.token);
  if (!v.ok || v.payload.sid !== id) {
    req.setFlash({ type: 'error', message: v.ok ? 'Confirmation is for a different session.' : v.reason });
    return res.redirect(back);
  }
  const t = v.payload;
  if (!consumeNonce(req, t.nonce, t.exp)) {
    req.setFlash({ type: 'error', message: 'This refund was already submitted. Check the refunds below before trying again.' });
    return res.redirect(back);
  }

  const body = {
    full: t.full,
    reason_category: t.reason,
    note: t.note,
    provider_liable: t.providerLiable,
  };
  if (!t.full) body.amount_paise = t.amount;

  const r = await backend.refund(req.viewer.id, id, body);
  if (!r.ok) {
    req.setFlash({ type: 'error', message: `Refund not created: ${r.message}` });
    return res.redirect(back);
  }

  const parts = asList(r.data, 'refunds');
  const failed = parts.filter((p) => p.status === 'failed');
  const total = Number(r.data && r.data.amount) || parts.reduce((n, p) => n + Number(p.amount || 0), 0) || t.amount;
  req.setFlash(
    failed.length
      ? {
          type: 'error',
          message: `Refund of ${P.inr(total)} recorded, but Razorpay rejected ${failed.length} part(s): ${failed
            .map((p) => p.last_error || 'no reason given')
            .join('; ')}. Use Retry under Refunds once fixed.`,
        }
      : {
          type: 'success',
          message: `Refund of ${P.inr(total)} submitted (${parts.map((p) => p.status).join(', ') || 'pending'}). The client usually sees it in 5–7 working days.`,
        },
  );
  res.redirect(back);
});

// -------------------------------------------------------------- outcome ---

router.post('/:id/outcome', requirePerm('outcome'), async (req, res) => {
  const { id } = req.params;
  const back = `/sessions/${id}#outcome`;
  const fault = req.body.fault;
  const note = cleanNote(req.body.note);

  if (!P.FAULTS.some((f) => f.value === fault)) {
    req.setFlash({ type: 'error', message: 'Pick an outcome.' });
    return res.redirect(back);
  }
  if (note.length < MIN_NOTE) {
    req.setFlash({ type: 'error', message: `A note of at least ${MIN_NOTE} characters is required.` });
    return res.redirect(back);
  }
  const body = { fault, note };
  // The optional settlement override rides along only for roles that may
  // change settlements; a support agent's form never shows it.
  if (req.body.settlement && P.can(req.viewer.role, 'settlement')) {
    if (!P.SETTLEMENT_STATES.some((s) => s.value === req.body.settlement)) {
      req.setFlash({ type: 'error', message: 'Unknown settlement status.' });
      return res.redirect(back);
    }
    body.settlement = req.body.settlement;
  }

  const r = await backend.outcome(req.viewer.id, id, body);
  req.setFlash(
    r.ok
      ? { type: 'success', message: `Outcome set to "${P.FAULT_LABEL[fault]}".` }
      : { type: 'error', message: `Outcome not changed: ${r.message}` },
  );
  res.redirect(back);
});

// ----------------------------------------------------------- settlement ---

router.post('/:id/settlement', requirePerm('settlement'), async (req, res) => {
  const { id } = req.params;
  const back = `/sessions/${id}#settlement`;
  const status = req.body.status;
  const note = cleanNote(req.body.note);

  if (!P.SETTLEMENT_STATES.some((s) => s.value === status)) {
    req.setFlash({ type: 'error', message: 'Pick a settlement status.' });
    return res.redirect(back);
  }
  if (note.length < MIN_NOTE) {
    req.setFlash({ type: 'error', message: `A note of at least ${MIN_NOTE} characters is required.` });
    return res.redirect(back);
  }
  const r = await backend.settlement(req.viewer.id, id, { status, note });
  req.setFlash(
    r.ok
      ? { type: 'success', message: `Provider share set to ${P.SETTLEMENT_LABEL[status]}.` }
      : { type: 'error', message: `Settlement not changed: ${r.message}` },
  );
  res.redirect(back);
});

module.exports = router;
