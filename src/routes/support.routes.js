const express = require('express');
const { requireSupportAccess } = require('../middleware/auth');
const q = require('../lib/supportQueries');
const { sparklineSvg } = require('../lib/sparkline');

const router = express.Router();
router.use(requireSupportAccess);

// Every render in this module uses the support layout, and every page needs
// the agent identity + the unresolved-alert badge in the nav. Doing it once
// here keeps it out of each individual handler.
router.use(async (req, res, next) => {
  res.locals.layout = 'partials/supportLayout';
  const agent = req.session.supportAgent || req.session.superAdmin;
  res.locals.agent = agent;
  // A super admin reaching these pages should not get the support agent's
  // log-out button — that would drop their admin session too.
  res.locals.viewerIsSuperAdmin = Boolean(req.session.superAdmin);
  try {
    const counts = await q.alertCounts();
    res.locals.navCounts = counts;
  } catch (err) {
    console.error('[support] alert counts failed:', err.message);
    res.locals.navCounts = { new: 0, urgent: 0 };
  }
  next();
});

function agentId(req) {
  const a = req.session.supportAgent || req.session.superAdmin;
  return a ? a.id : null;
}

// Small helper: async handlers that throw should reach the app error handler
// instead of hanging the request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- alerts ---

router.get('/', (req, res) => res.redirect('/support/alerts'));

router.get(
  '/alerts',
  wrap(async (req, res) => {
    // Default view is the working queue (new + acknowledged), not everything
    // ever recorded — a resolved alert from three months ago is not what an
    // agent opening this page needs to see first.
    const status = req.query.status || 'open';
    const severity = req.query.severity ? parseInt(req.query.severity, 10) : null;

    let alerts;
    if (status === 'open') {
      const [fresh, ack] = await Promise.all([
        q.listAlerts({ status: 'new', severity }),
        q.listAlerts({ status: 'acknowledged', severity }),
      ]);
      alerts = [...fresh, ...ack];
    } else {
      alerts = await q.listAlerts({ status: status === 'all' ? null : status, severity });
    }

    res.render('support/alerts', {
      title: 'Crisis alerts',
      alerts,
      counts: res.locals.navCounts,
      status,
      severity: severity || '',
    });
  }),
);

// The link that crisis alert emails point at. Sends the agent to the case
// view with the right alert already selected.
router.get(
  '/alerts/:id',
  wrap(async (req, res) => {
    const alert = await q.getAlert(req.params.id);
    if (!alert) return res.status(404).render('errors/404', { layout: false, backHref: '/support/alerts', backLabel: 'Back to alerts' });
    res.redirect(`/support/user/${alert.user_id}?alert=${alert.id}`);
  }),
);

router.post(
  '/alerts/:id/status',
  wrap(async (req, res) => {
    const { status, resolution_notes: notes, redirect } = req.body;
    const allowed = ['new', 'acknowledged', 'resolved', 'false_positive'];
    if (!allowed.includes(status)) {
      req.setFlash({ type: 'error', message: 'Unknown alert status.' });
      return res.redirect(redirect || '/support/alerts');
    }
    // Resolving without a note leaves the next agent guessing what happened,
    // so it's required on the two terminal states.
    if ((status === 'resolved' || status === 'false_positive') && !(notes || '').trim()) {
      req.setFlash({ type: 'error', message: 'Add a resolution note before closing an alert.' });
      return res.redirect(redirect || '/support/alerts');
    }

    const updated = await q.updateAlertStatus({
      alertId: req.params.id,
      status,
      agentId: agentId(req),
      notes,
    });
    if (!updated) return res.status(404).render('errors/404', { layout: false, backHref: '/support/alerts', backLabel: 'Back to alerts' });

    await q.logSupportAction({
      adminId: agentId(req),
      action: `crisis_alert.${status}`,
      targetTable: 'crisis_alerts',
      targetId: updated.id,
      details: { user_id: updated.user_id, notes: notes || null },
    });

    req.setFlash({ type: 'success', message: `Alert marked ${status.replace('_', ' ')}.` });
    res.redirect(redirect || '/support/alerts');
  }),
);

router.post(
  '/alerts/:id/claim',
  wrap(async (req, res) => {
    const claimed = await q.claimAlert({ alertId: req.params.id, agentId: agentId(req) });
    if (!claimed) return res.status(404).render('errors/404', { layout: false, backHref: '/support/alerts', backLabel: 'Back to alerts' });
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'crisis_alert.claim',
      targetTable: 'crisis_alerts',
      targetId: claimed.id,
      details: { user_id: claimed.user_id },
    });
    res.redirect(req.body.redirect || '/support/alerts');
  }),
);


// ----------------------------------------------- check-in questions ---
// The daily check-in is the mood tracking instrument, so this is where its
// questions are written and corrected. Reachable by the same support access
// as the rest of this console.

const QUESTION_TYPES = ['single_select', 'multi_select', 'slider'];

function questionFieldsFromBody(body) {
  const type = body.question_type;
  const toInt = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  };
  return {
    questionText: (body.question_text || '').trim(),
    questionType: type,
    // Only the fields that belong to the chosen type are kept; a slider's
    // labels have no meaning on a select, and vice versa.
    maxSelections: type === 'multi_select' ? toInt(body.max_selections) : null,
    sliderMin: type === 'slider' ? toInt(body.slider_min) : null,
    sliderMax: type === 'slider' ? toInt(body.slider_max) : null,
    sliderMinLabel: type === 'slider' ? (body.slider_min_label || '').trim() || null : null,
    sliderMaxLabel: type === 'slider' ? (body.slider_max_label || '').trim() || null : null,
  };
}

function validateQuestion(fields) {
  if (!fields.questionText) return 'Question text is required.';
  if (fields.questionText.length > 200) return 'Question text is too long.';
  if (fields.questionType === 'slider') {
    if (fields.sliderMin === null || fields.sliderMax === null) return 'A slider needs both a minimum and a maximum.';
    if (fields.sliderMin >= fields.sliderMax) return 'Slider minimum must be lower than its maximum.';
  }
  if (fields.questionType === 'multi_select' && fields.maxSelections !== null && fields.maxSelections < 1) {
    return 'Max selections must be at least 1.';
  }
  return null;
}

router.get(
  '/questions',
  wrap(async (req, res) => {
    const questions = await q.listQuestions();
    res.render('support/questions', { title: 'Check-in questions', questions });
  }),
);

router.post(
  '/questions',
  wrap(async (req, res) => {
    const fields = questionFieldsFromBody(req.body);
    if (!QUESTION_TYPES.includes(fields.questionType)) {
      req.setFlash({ type: 'error', message: 'Pick a question type.' });
      return res.redirect('/support/questions');
    }
    const problem = validateQuestion(fields);
    if (problem) {
      req.setFlash({ type: 'error', message: problem });
      return res.redirect('/support/questions');
    }

    const created = await q.createQuestion({ ...fields, createdBy: agentId(req) });
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'checkin_question.create',
      targetTable: 'survey_questions',
      targetId: created.id,
      details: { question_text: fields.questionText, question_type: fields.questionType },
    });

    if (fields.questionType === 'slider') {
      req.setFlash({ type: 'success', message: 'Question added and live from the next check-in.' });
      return res.redirect('/support/questions');
    }
    // A select with no options is unanswerable, so go straight to where they
    // get added rather than leaving a broken question in the list.
    req.setFlash({ type: 'success', message: 'Question added — now give it some answer options.' });
    res.redirect(`/support/questions/${created.id}`);
  }),
);

router.get(
  '/questions/:id',
  wrap(async (req, res) => {
    const question = await q.getQuestion(req.params.id);
    if (!question) return res.status(404).render('errors/404', { layout: false, backHref: '/support/questions', backLabel: 'Back to questions' });
    res.render('support/questionEdit', { title: 'Edit question', question });
  }),
);

router.post(
  '/questions/:id',
  wrap(async (req, res) => {
    const existing = await q.getQuestion(req.params.id);
    if (!existing) return res.status(404).render('errors/404', { layout: false, backHref: '/support/questions', backLabel: 'Back to questions' });

    // The stored type wins over anything posted — see updateQuestion's note
    // on why type changes are not allowed.
    const fields = questionFieldsFromBody({ ...req.body, question_type: existing.question_type });
    const problem = validateQuestion(fields);
    if (problem) {
      req.setFlash({ type: 'error', message: problem });
      return res.redirect(`/support/questions/${req.params.id}`);
    }

    await q.updateQuestion(req.params.id, fields);
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'checkin_question.update',
      targetTable: 'survey_questions',
      targetId: req.params.id,
      details: { from: existing.question_text, to: fields.questionText },
    });
    req.setFlash({ type: 'success', message: 'Question updated.' });
    res.redirect(`/support/questions/${req.params.id}`);
  }),
);

router.post(
  '/questions/:id/active',
  wrap(async (req, res) => {
    const active = req.body.active === 'true';
    const updated = await q.setQuestionActive(req.params.id, active);
    if (!updated) return res.status(404).render('errors/404', { layout: false, backHref: '/support/questions', backLabel: 'Back to questions' });
    await q.logSupportAction({
      adminId: agentId(req),
      action: active ? 'checkin_question.activate' : 'checkin_question.retire',
      targetTable: 'survey_questions',
      targetId: req.params.id,
    });
    req.setFlash({
      type: 'success',
      message: active ? 'Question is live again.' : 'Question retired — existing answers are kept.',
    });
    res.redirect(req.body.redirect || '/support/questions');
  }),
);

router.post(
  '/questions/:id/move',
  wrap(async (req, res) => {
    await q.moveQuestion(req.params.id, req.body.direction === 'up' ? 'up' : 'down');
    res.redirect('/support/questions');
  }),
);

router.post(
  '/questions/:id/options',
  wrap(async (req, res) => {
    const optionText = (req.body.option_text || '').trim();
    if (!optionText) {
      req.setFlash({ type: 'error', message: 'Option text is required.' });
      return res.redirect(`/support/questions/${req.params.id}`);
    }
    const created = await q.addOption(req.params.id, { optionText, emoji: (req.body.emoji || '').trim() });
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'checkin_option.create',
      targetTable: 'survey_question_options',
      targetId: created.id,
      details: { question_id: req.params.id, option_text: optionText },
    });
    res.redirect(`/support/questions/${req.params.id}`);
  }),
);

router.post(
  '/options/:optionId',
  wrap(async (req, res) => {
    const optionText = (req.body.option_text || '').trim();
    if (!optionText) {
      req.setFlash({ type: 'error', message: 'Option text is required.' });
      return res.redirect(req.body.redirect || '/support/questions');
    }
    const updated = await q.updateOption(req.params.optionId, { optionText, emoji: (req.body.emoji || '').trim() });
    if (!updated) return res.status(404).render('errors/404', { layout: false, backHref: '/support/questions', backLabel: 'Back to questions' });
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'checkin_option.update',
      targetTable: 'survey_question_options',
      targetId: req.params.optionId,
      details: { option_text: optionText },
    });
    res.redirect(`/support/questions/${updated.question_id}`);
  }),
);

router.post(
  '/options/:optionId/active',
  wrap(async (req, res) => {
    const active = req.body.active === 'true';
    const updated = await q.setOptionActive(req.params.optionId, active);
    if (!updated) return res.status(404).render('errors/404', { layout: false, backHref: '/support/questions', backLabel: 'Back to questions' });
    await q.logSupportAction({
      adminId: agentId(req),
      action: active ? 'checkin_option.activate' : 'checkin_option.retire',
      targetTable: 'survey_question_options',
      targetId: req.params.optionId,
    });
    res.redirect(`/support/questions/${updated.question_id}`);
  }),
);

router.post(
  '/options/:optionId/delete',
  wrap(async (req, res) => {
    const result = await q.deleteOptionIfUnused(req.params.optionId);
    if (result.reason === 'not_found') {
      return res.status(404).render('errors/404', { layout: false, backHref: '/support/questions', backLabel: 'Back to questions' });
    }
    if (!result.deleted) {
      req.setFlash({
        type: 'error',
        message: `That option has been chosen ${result.useCount} time(s) — retire it instead so past answers still make sense.`,
      });
      return res.redirect(`/support/questions/${result.questionId}`);
    }
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'checkin_option.delete',
      targetTable: 'survey_question_options',
      targetId: req.params.optionId,
      details: { question_id: result.questionId },
    });
    req.setFlash({ type: 'success', message: 'Option deleted.' });
    res.redirect(`/support/questions/${result.questionId}`);
  }),
);

// --------------------------------------------------------------- clients ---

router.get(
  '/clients',
  wrap(async (req, res) => {
    const search = (req.query.search || '').trim();
    const clients = await q.searchClients({ search });
    res.render('support/clients', { title: 'Clients', clients, search });
  }),
);

// ------------------------------------------------------------ case view ---

router.get(
  '/user/:userId',
  wrap(async (req, res) => {
    const { userId } = req.params;
    const tab = req.query.tab || 'alerts';
    const days = Math.min(parseInt(req.query.days, 10) || 60, 365);

    // Named clientProfile, never `client`: EJS 3 lifts a render local called
    // `client` into its compiler options, silently compiling the template in
    // client mode where `include` is not supplied. See the guard in server.js.
    const clientProfile = await q.getClient(userId);
    if (!clientProfile) return res.status(404).render('errors/404', { layout: false, backHref: '/support/alerts', backLabel: 'Back to alerts' });

    const alerts = await q.listAlertsForUser(userId);

    // Which alert's content to show. Explicit ?alert wins; otherwise fall
    // back to the legacy ?message= param that older crisis emails used, and
    // failing both, the newest unresolved alert.
    let selectedAlert = null;
    if (req.query.alert) {
      selectedAlert = alerts.find((a) => a.id === req.query.alert) || null;
    } else if (req.query.message) {
      selectedAlert = alerts.find((a) => a.source_message_id === req.query.message) || null;
    }
    if (!selectedAlert) {
      selectedAlert = alerts.find((a) => a.status === 'new' || a.status === 'acknowledged') || alerts[0] || null;
    }

    let flagged = { kind: null, messages: [], entry: null };
    if (selectedAlert) {
      flagged = await q.getFlaggedContent({
        userId,
        sourceTable: selectedAlert.source_table,
        sourceMessageId: selectedAlert.source_message_id,
      });
    } else if (req.query.message) {
      // Deep link with a message id but no matching alert row — still honour
      // it, since that's what the old email template produced.
      flagged = await q.getFlaggedContent({
        userId,
        sourceTable: 'ai_messages',
        sourceMessageId: req.query.message,
      });
    }

    const [history, journalTags, streak, reports] = await Promise.all([
      q.getMoodHistory({ userId, days }),
      q.getJournalMoodTags({ userId, days }),
      q.getCheckinStreak(userId),
      q.listWellnessReports(userId),
    ]);
    // SVG is built here rather than in the template — see lib/sparkline.js
    // for why this stopped being an EJS partial.
    const series = q.buildMoodSeries(history).map((s) => ({ ...s, svg: sparklineSvg(s) }));

    res.render('support/user', {
      title: clientProfile.full_name || 'Client',
      clientProfile,
      tab,
      days,
      alerts,
      selectedAlert,
      flagged,
      flaggedMessageId: selectedAlert ? selectedAlert.source_message_id : req.query.message || null,
      history,
      series,
      journalTags,
      streak,
      reports,
    });
  }),
);

// -------------------------------------------------------------- wellness ---

router.post(
  '/user/:userId/wellness',
  wrap(async (req, res) => {
    const { userId } = req.params;
    const {
      title, summary, report_period_start: start, report_period_end: end,
      file_url: fileUrl, visible_to_client: visible,
    } = req.body;

    if (!title || !start || !end) {
      req.setFlash({ type: 'error', message: 'Title and both period dates are required.' });
      return res.redirect(`/support/user/${userId}?tab=wellness`);
    }
    if (new Date(end) < new Date(start)) {
      req.setFlash({ type: 'error', message: 'Report period ends before it starts.' });
      return res.redirect(`/support/user/${userId}?tab=wellness`);
    }

    // Metrics are derived here, not posted. They're a summary of the
    // client's own check-ins, so letting an agent hand-edit the blob would
    // only allow it to contradict the data it claims to describe.
    //
    // Recomputed over the report's own period rather than reusing whatever
    // window the page happened to be showing, so the figures match the dates
    // on the report.
    const periodDays = Math.max(
      1,
      Math.ceil((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1,
    );
    const [periodHistory, periodTags] = await Promise.all([
      q.getMoodHistory({ userId, days: periodDays }),
      q.getJournalMoodTags({ userId, days: periodDays }),
    ]);
    const metrics = q.summarizeMetrics({
      series: q.buildMoodSeries(periodHistory),
      history: periodHistory,
      journalTags: periodTags,
    });

    const created = await q.createWellnessReport({
      clientId: userId,
      title,
      summary,
      periodStart: start,
      periodEnd: end,
      metrics,
      fileUrl,
      createdBy: agentId(req),
      visible: visible === 'on',
    });

    await q.logSupportAction({
      adminId: agentId(req),
      action: 'wellness_report.create',
      targetTable: 'wellness_reports',
      targetId: created.id,
      details: { client_id: userId, period: [start, end], visible: visible === 'on' },
    });

    req.setFlash({ type: 'success', message: 'Wellness report saved.' });
    res.redirect(`/support/user/${userId}?tab=wellness`);
  }),
);

router.post(
  '/wellness/:id/visibility',
  wrap(async (req, res) => {
    const visible = req.body.visible === 'true';
    const updated = await q.setReportVisibility({ reportId: req.params.id, visible });
    if (!updated) return res.status(404).render('errors/404', { layout: false, backHref: '/support/alerts', backLabel: 'Back to alerts' });
    await q.logSupportAction({
      adminId: agentId(req),
      action: 'wellness_report.visibility',
      targetTable: 'wellness_reports',
      targetId: updated.id,
      details: { client_id: updated.client_id, is_visible_to_client: visible },
    });
    req.setFlash({
      type: 'success',
      message: visible ? 'Report is now visible to the client.' : 'Report hidden from the client.',
    });
    res.redirect(`/support/user/${updated.client_id}?tab=wellness`);
  }),
);

module.exports = router;
