const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { sendMail } = require('../config/mailer');
const { pickArray } = require('../lib/forms');
const { uuidParams, normalizeEmail, isEmail, isUuid, escapeHtml } = require('../lib/validate');
const G = require('../lib/gendocs');

// General doctors exist ONLY through this dashboard — contracted by WMT for
// specific organizations, so there is no self-signup. No payment anywhere:
// no session rate, no KYC, no Razorpay; orgs are billed out of band.

const router = express.Router();
router.use(requireSuperAdmin);
uuidParams(router, ['userId', 'orgId', 'entryId'], '/gendocs', 'Back to doctors');

const TABS = ['review', 'approved', 'suspended', 'rejected', 'all'];
const LEGACY = { pending_review: 'review', draft: 'review', submitted: 'review' };

router.use((req, res, next) => {
  res.locals.G = G;
  next();
});

// ------------------------------------------------------------------ list ---

router.get('/', async (req, res) => {
  const raw = req.query.tab || req.query.status || 'review';
  const tab = TABS.includes(raw) ? raw : LEGACY[raw] || 'review';

  const { data: all, error } = await supabase
    .from('gendoc_profiles')
    .select(
      `user_id, full_name, professional_title, registration_no, registration_council, qualifications, bio, photo_url,
       years_experience, application_status, is_accepting_queue, consultation_minutes, timezone,
       profile_completed_by_gendoc, password_set_by_gendoc, created_at,
       gendoc_org_assignments(org_id, is_active, organizations(company_name, status))`,
    )
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load doctors — ${error.message}`);

  const counts = { all: all.length, review: 0, approved: 0, suspended: 0, rejected: 0 };
  all.forEach((g) => {
    if (G.REVIEW_STATUSES.includes(g.application_status)) counts.review += 1;
    else if (counts[g.application_status] !== undefined) counts[g.application_status] += 1;
  });

  const rows = all.filter((g) =>
    tab === 'all' ? true : tab === 'review' ? G.REVIEW_STATUSES.includes(g.application_status) : g.application_status === tab,
  );

  const ids = rows.map((g) => g.user_id);
  const waiting = {};
  const users = {};
  if (ids.length) {
    const [{ data: q }, { data: u }] = await Promise.all([
      supabase.from('gendoc_queue_entries').select('gendoc_id, queue_date').in('gendoc_id', ids).eq('status', 'waiting'),
      supabase.from('users').select('id, email, status').in('id', ids),
    ]);
    (q || []).forEach((e) => {
      const g = rows.find((r) => r.user_id === e.gendoc_id);
      if (g && e.queue_date === G.todayIn(g.timezone)) waiting[e.gendoc_id] = (waiting[e.gendoc_id] || 0) + 1;
    });
    (u || []).forEach((x) => (users[x.id] = x));
  }

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, company_name')
    .eq('general_doctor_feature_enabled', true)
    .eq('status', 'active')
    .order('company_name');

  res.render('gendocs/index', {
    tab,
    counts,
    gendocs: rows.map((g) => ({ ...g, check: G.readiness(g), waitingToday: waiting[g.user_id] || 0, account: users[g.user_id] || null })),
    orgs: orgs || [],
  });
});

// ---------------------------------------------------------------- create ---

router.post('/', async (req, res) => {
  const { professional_title, registration_no, registration_council } = req.body;
  const fullName = String(req.body.full_name || '').trim();
  const email = normalizeEmail(req.body.email);
  if (!isEmail(email) || fullName.length < 2) {
    req.setFlash({ type: 'error', message: 'A valid email and a name are both required.' });
    return res.redirect('/gendocs');
  }

  const { data: existing } = await supabase.from('users').select('id, role').eq('email', email).maybeSingle();
  if (existing) {
    req.setFlash({
      type: 'error',
      message: `${email} already has a WMT account (${existing.role}). Doctors need their own email — use a different one.`,
    });
    return res.redirect('/gendocs');
  }

  const tempPassword = generateTempPassword();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not create doctor — ' + error.message });
    return res.redirect('/gendocs');
  }
  const userId = data.user.id;
  const rollback = async () => {
    await supabase.from('gendoc_profiles').delete().eq('user_id', userId);
    await supabase.from('users').delete().eq('id', userId);
    await supabase.auth.admin.deleteUser(userId).catch(() => {});
  };

  // Upsert, not update: if the auth trigger hasn't created the public.users
  // row, an update silently matches nothing and the doctor has no role.
  const { error: roleError } = await supabase.from('users').upsert({ id: userId, email, role: 'gendoc' }, { onConflict: 'id' });
  if (roleError) {
    await rollback();
    req.setFlash({ type: 'error', message: 'Could not set the account role — ' + roleError.message });
    return res.redirect('/gendocs');
  }

  const { error: profileError } = await supabase.from('gendoc_profiles').insert({
    user_id: userId,
    full_name: fullName,
    professional_title: String(professional_title || '').trim() || 'General Physician',
    registration_no: String(registration_no || '').trim() || null,
    registration_council: String(registration_council || '').trim() || null,
    application_status: 'draft',
    profile_completed_by_gendoc: false,
    password_set_by_gendoc: false,
  });
  if (profileError) {
    await rollback();
    req.setFlash({ type: 'error', message: 'Could not create doctor profile — ' + profileError.message });
    return res.redirect('/gendocs');
  }

  // Default Mon–Fri 9–5 with a 1–2 lunch, so ETAs work the moment they're
  // assigned. Editable below or by the doctor in the app.
  await supabase.from('gendoc_schedules').upsert(
    { gendoc_id: userId, day_start: '09:00', day_end: '17:00', lunch_start: '13:00', lunch_end: '14:00', working_days: [1, 2, 3, 4, 5] },
    { onConflict: 'gendoc_id' },
  );

  await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.created', targetTable: 'gendoc_profiles', targetId: userId, details: { email } });

  await sendMail({
    to: email,
    subject: "Doctor account created — Where's My Therapist",
    html: `<p>Hi ${escapeHtml(fullName)},</p>
      <p>Your general doctor account on Where's My Therapist is ready.</p>
      <p>Login email: <strong>${escapeHtml(email)}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
      <p>Open the Where's My Therapist app, sign in, set your own password and complete your profile. We'll review it and assign your organizations.</p>`,
  });

  req.setFlash({ type: 'success', message: `Doctor account created. Temp password (shown once): ${tempPassword}` });
  res.redirect(`/gendocs/${userId}`);
});

// ---------------------------------------------------------------- detail ---

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  const [{ data: gendoc }, { data: user }, { data: schedule }, { data: assignments }, { data: orgs }, { data: langs }] = await Promise.all([
    supabase.from('gendoc_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('users').select('id, email, phone, status, created_at').eq('id', userId).maybeSingle(),
    supabase.from('gendoc_schedules').select('*').eq('gendoc_id', userId).maybeSingle(),
    supabase
      .from('gendoc_org_assignments')
      .select('org_id, is_active, assigned_at, organizations(id, company_name, status, general_doctor_feature_enabled)')
      .eq('gendoc_id', userId),
    supabase.from('organizations').select('id, company_name').eq('general_doctor_feature_enabled', true).eq('status', 'active').order('company_name'),
    supabase.from('gendoc_languages').select('language_id, languages(name)').eq('gendoc_id', userId),
  ]);
  if (!gendoc) return res.status(404).render('errors/404', { layout: false, backHref: '/gendocs', backLabel: 'Back to doctors' });

  const today = G.todayIn(gendoc.timezone);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [{ data: queue }, { data: history }, authRes, { data: audit }] = await Promise.all([
    supabase
      .from('gendoc_queue_entries')
      .select('id, status, position, estimated_start, requested_at, actual_start, actual_end, org_id, queue_date, organizations(company_name)')
      .eq('gendoc_id', userId)
      .eq('queue_date', today)
      .order('position'),
    supabase
      .from('gendoc_queue_entries')
      .select('status, requested_at, actual_start, actual_end, queue_date')
      .eq('gendoc_id', userId)
      .gte('queue_date', since),
    supabase.auth.admin.getUserById(userId).catch((e) => ({ error: e })),
    supabase
      .from('admin_audit_log')
      .select('action, details, created_at, admin_id')
      .eq('target_id', userId)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  // Last 30 days.
  const h = history || [];
  const done = h.filter((x) => x.status === 'completed' && x.actual_start);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const stats = {
    total: h.length,
    completed: h.filter((x) => x.status === 'completed').length,
    noShow: h.filter((x) => x.status === 'no_show').length,
    cancelled: h.filter((x) => x.status === 'cancelled').length,
    avgWaitMin: avg(done.map((x) => (new Date(x.actual_start) - new Date(x.requested_at)) / 60000)),
    avgConsultMin: avg(done.filter((x) => x.actual_end).map((x) => (new Date(x.actual_end) - new Date(x.actual_start)) / 60000)),
    staleOpen: h.filter((x) => ['waiting', 'in_progress'].includes(x.status) && x.queue_date < today).length,
  };

  const active = (assignments || []).filter((a) => a.is_active);
  const assignedIds = new Set(active.map((a) => a.org_id));
  const check = G.readiness(gendoc, { languages: (langs || []).length, schedule });
  const allowed = Object.keys(G.TRANSITIONS).filter((d) => G.TRANSITIONS[d].includes(gendoc.application_status));
  const hasLogin = Boolean(authRes && authRes.data && authRes.data.user);

  // Can an employee actually reach this doctor right now?
  const dow = new Date(`${today}T12:00:00`).getDay();
  const reach = [
    { label: 'Approved', ok: gendoc.application_status === 'approved' },
    { label: 'Account active', ok: Boolean(user && user.status === 'active') },
    { label: 'Has a working login', ok: hasLogin },
    { label: 'Assigned to an active organization', ok: active.some((a) => a.organizations && a.organizations.status === 'active') },
    { label: 'Accepting the queue', ok: gendoc.is_accepting_queue },
    { label: `Works today (${G.DAY_NAMES[dow]})`, ok: (schedule ? schedule.working_days : [1, 2, 3, 4, 5]).includes(dow) },
  ];

  res.render('gendocs/show', {
    title: gendoc.full_name,
    gendoc,
    user: user || null,
    hasLogin,
    schedule: schedule || null,
    assignments: active,
    availableOrgs: (orgs || []).filter((o) => !assignedIds.has(o.id)),
    languages: (langs || []).map((l) => l.languages && l.languages.name).filter(Boolean),
    queue: queue || [],
    today,
    stats,
    check,
    allowed,
    reach,
    audit: audit || [],
  });
});

// -------------------------------------------------------------- decision ---

router.post('/:userId/decision', async (req, res) => {
  const { userId } = req.params;
  const legacy = { approved: 'approve', rejected: 'reject', suspended: 'suspend' };
  const decision = legacy[req.body.decision] || req.body.decision;
  const reason = req.body.reason || req.body.rejection_reason || '';
  const result = await G.applyDecision(supabase, { userId, decision, reason, adminId: req.session.superAdmin.id });
  if (!result.ok) {
    req.setFlash({ type: 'error', message: result.message });
    return res.redirect(`/gendocs/${userId}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `gendoc.${result.to}`,
    targetTable: 'gendoc_profiles',
    targetId: userId,
    details: { from: result.from, reason: reason || null, queue_cancelled: result.cancelled || 0 },
  });

  let message = `${result.name} ${result.to}.`;
  if (result.to === 'approved') {
    const { data: active } = await supabase.from('gendoc_org_assignments').select('org_id').eq('gendoc_id', userId).eq('is_active', true);
    message += active && active.length
      ? ' Visible to employees of their organizations.'
      : ' Not assigned to any organization yet — nobody can see them until you assign one below.';
  }
  if (result.cancelled) message += ` ${result.cancelled} waiting employee(s) were told today's consult is cancelled.`;
  if (!result.emailed) message += ' (Email not sent — they still get the in-app notification.)';
  req.setFlash({ type: result.to === 'approved' ? 'success' : 'info', message });
  res.redirect(`/gendocs/${userId}`);
});

// ------------------------------------------------------------ assignments ---

router.post('/:userId/assignments', async (req, res) => {
  const { userId } = req.params;
  const orgIds = pickArray(req.body, 'org_id').filter(isUuid);
  if (!orgIds.length) {
    req.setFlash({ type: 'error', message: 'Pick an organization first.' });
    return res.redirect(`/gendocs/${userId}#orgs`);
  }
  // The form only lists eligible orgs, but the ids come from the browser.
  const { data: eligible } = await supabase
    .from('organizations')
    .select('id')
    .in('id', orgIds)
    .eq('general_doctor_feature_enabled', true)
    .eq('status', 'active');
  const ok = (eligible || []).map((o) => o.id);
  if (!ok.length) {
    req.setFlash({ type: 'error', message: "Those organizations don't have the general doctor feature (HR-Onboarding plan) or aren't active." });
    return res.redirect(`/gendocs/${userId}#orgs`);
  }
  const { error } = await supabase.from('gendoc_org_assignments').upsert(
    ok.map((orgId) => ({ gendoc_id: userId, org_id: orgId, assigned_by: req.session.superAdmin.id, assigned_at: new Date().toISOString(), is_active: true })),
    { onConflict: 'gendoc_id,org_id' },
  );
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not assign — ' + error.message });
    return res.redirect(`/gendocs/${userId}#orgs`);
  }
  await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.org_assigned', targetTable: 'gendoc_org_assignments', targetId: userId, details: { org_ids: ok } });
  req.setFlash({ type: 'success', message: `Assigned to ${ok.length} organization(s).` });
  res.redirect(`/gendocs/${userId}#orgs`);
});

router.post('/:userId/assignments/:orgId/remove', async (req, res) => {
  const { userId, orgId } = req.params;
  const { error } = await supabase.from('gendoc_org_assignments').update({ is_active: false }).eq('gendoc_id', userId).eq('org_id', orgId);
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not remove — ' + error.message });
    return res.redirect(`/gendocs/${userId}#orgs`);
  }
  // That org's employees can no longer see the doctor, so their place in
  // today's queue would be a dead end.
  const { data: g } = await supabase.from('gendoc_profiles').select('timezone').eq('user_id', userId).maybeSingle();
  const cancelled = await G.cancelTodaysQueue(supabase, {
    gendocId: userId,
    tz: g && g.timezone,
    orgId,
    adminId: req.session.superAdmin.id,
    why: 'Your doctor consultation for today was cancelled — this doctor no longer serves your organization.',
  });
  await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.org_unassigned', targetTable: 'gendoc_org_assignments', targetId: userId, details: { org_id: orgId, queue_cancelled: cancelled } });
  req.setFlash({ type: 'success', message: `Organization removed.${cancelled ? ` ${cancelled} waiting employee(s) from it were notified.` : ''}` });
  res.redirect(`/gendocs/${userId}#orgs`);
});

// ---------------------------------------------------------- queue control ---

router.post('/:userId/accepting', async (req, res) => {
  const { userId } = req.params;
  const accepting = req.body.accepting === 'true';
  const { error } = await supabase.from('gendoc_profiles').update({ is_accepting_queue: accepting }).eq('user_id', userId);
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not update — ' + error.message });
    return res.redirect(`/gendocs/${userId}`);
  }
  await logAction({ adminId: req.session.superAdmin.id, action: accepting ? 'gendoc.queue_opened' : 'gendoc.queue_closed', targetTable: 'gendoc_profiles', targetId: userId });
  req.setFlash({ type: 'success', message: accepting ? 'Queue open to new requests.' : 'Queue closed to new requests. People already waiting keep their place.' });
  res.redirect(`/gendocs/${userId}`);
});

router.post('/:userId/queue/:entryId/cancel', async (req, res) => {
  const { userId, entryId } = req.params;
  const { data: rows, error } = await supabase
    .from('gendoc_queue_entries')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: req.session.superAdmin.id, updated_at: new Date().toISOString() })
    .eq('id', entryId)
    .eq('gendoc_id', userId)
    .in('status', ['waiting', 'in_progress'])
    .select('client_id, queue_date');
  if (error || !rows || !rows.length) {
    req.setFlash({ type: 'error', message: error ? error.message : 'That entry is no longer waiting.' });
    return res.redirect(`/gendocs/${userId}#queue`);
  }
  await supabase.rpc('fn_recompute_gendoc_queue', { p_gendoc_id: userId, p_date: rows[0].queue_date });
  await G.notify(
    supabase,
    rows[0].client_id,
    'Consultation cancelled',
    'Your doctor consultation was cancelled by our team. You can join the queue again if you still need it.',
    'gendoc_queue_cancelled',
  );
  await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.queue_entry_cancelled', targetTable: 'gendoc_queue_entries', targetId: entryId, details: { gendoc_id: userId } });
  req.setFlash({ type: 'success', message: 'Entry cancelled, the employee was notified and everyone behind them moved up.' });
  res.redirect(`/gendocs/${userId}#queue`);
});

router.post('/:userId/close-stale', async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase.rpc('fn_close_stale_gendoc_queues', { p_gendoc_id: userId });
  if (error) {
    req.setFlash({
      type: 'error',
      message: /function|does not exist|PGRST202|schema cache/i.test(error.message)
        ? 'Run sql/2026-10-04_gendoc_pipeline.sql in Supabase first — it adds the clean-up function.'
        : error.message,
    });
  } else {
    await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.queue_stale_closed', targetTable: 'gendoc_profiles', targetId: userId, details: { closed: data } });
    req.setFlash({ type: 'success', message: `Closed ${data || 0} entr${data === 1 ? 'y' : 'ies'} left over from previous days.` });
  }
  res.redirect(`/gendocs/${userId}#queue`);
});

// --------------------------------------------------------------- schedule ---

router.post('/:userId/schedule', async (req, res) => {
  const { userId } = req.params;
  const v = G.validateSchedule(req.body);
  if (v.error) {
    req.setFlash({ type: 'error', message: v.error });
    return res.redirect(`/gendocs/${userId}#hours`);
  }
  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    supabase.from('gendoc_schedules').upsert({ gendoc_id: userId, ...v.schedule, updated_at: new Date().toISOString() }, { onConflict: 'gendoc_id' }),
    supabase.from('gendoc_profiles').update({ consultation_minutes: v.minutes }).eq('user_id', userId),
  ]);
  if (e1 || e2) {
    req.setFlash({ type: 'error', message: 'Could not save — ' + (e1 || e2).message });
    return res.redirect(`/gendocs/${userId}#hours`);
  }
  const { data: g } = await supabase.from('gendoc_profiles').select('timezone').eq('user_id', userId).maybeSingle();
  await supabase.rpc('fn_recompute_gendoc_queue', { p_gendoc_id: userId, p_date: G.todayIn(g && g.timezone) });
  await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.schedule_updated', targetTable: 'gendoc_schedules', targetId: userId, details: { ...v.schedule, consultation_minutes: v.minutes } });
  req.setFlash({ type: 'success', message: "Working hours saved. Today's estimated times were recalculated." });
  res.redirect(`/gendocs/${userId}#hours`);
});

// ------------------------------------------------------------ credentials ---

router.post('/:userId/reissue-password', async (req, res) => {
  const { userId } = req.params;
  const [{ data: user }, { data: g }] = await Promise.all([
    supabase.from('users').select('email').eq('id', userId).maybeSingle(),
    supabase.from('gendoc_profiles').select('full_name').eq('user_id', userId).maybeSingle(),
  ]);
  if (!user || !g) {
    req.setFlash({ type: 'error', message: 'No such doctor.' });
    return res.redirect('/gendocs');
  }
  const tempPassword = generateTempPassword();
  const { error } = await supabase.auth.admin.updateUserById(userId, { password: tempPassword });
  if (error) {
    req.setFlash({
      type: 'error',
      message: /not found/i.test(error.message)
        ? 'This doctor has no Supabase login (it was deleted). Mark the account deleted under Users and create the doctor again.'
        : 'Could not reset — ' + error.message,
    });
    return res.redirect(`/gendocs/${userId}`);
  }
  // Sends them back through "set your own password" in the app.
  await supabase.from('gendoc_profiles').update({ password_set_by_gendoc: false }).eq('user_id', userId);
  await sendMail({
    to: user.email,
    subject: "New temporary password — Where's My Therapist",
    html: `<p>Hi ${escapeHtml(g.full_name)},</p><p>A new temporary password was issued for your doctor account.</p>
      <p>Login email: <strong>${escapeHtml(user.email)}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
      <p>Sign in to the app — you'll be asked to set your own password. Your old password no longer works.</p>`,
  });
  await logAction({ adminId: req.session.superAdmin.id, action: 'gendoc.password_reissued', targetTable: 'gendoc_profiles', targetId: userId });
  req.setFlash({ type: 'success', message: `New temp password for ${user.email} (shown once): ${tempPassword}` });
  res.redirect(`/gendocs/${userId}`);
});

module.exports = router;
