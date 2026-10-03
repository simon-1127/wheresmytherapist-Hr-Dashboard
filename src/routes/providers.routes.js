const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { sendMail } = require('../config/mailer');
const { uuidParams, safeRedirect, sanitizeSearch, escapeHtml } = require('../lib/validate');
const { REVIEW_STATUSES, TRANSITIONS, readiness, rupees, applyDecision } = require('../lib/providers');

const router = express.Router();
router.use(requireSuperAdmin);
uuidParams(router, ['userId'], '/providers', 'Back to providers');

const TABS = ['review', 'incomplete', 'approved', 'rejected', 'suspended', 'all'];

// Old links/bookmarks used ?status=pending_review etc.
const LEGACY_TAB = { pending_review: 'review', submitted: 'review', under_review: 'review', draft: 'review' };

function countBy(rows, key) {
  const out = {};
  rows.forEach((r) => (out[r[key]] = (out[r[key]] || 0) + 1));
  return out;
}

/** Provider-role accounts that never created a provider_profiles row. */
async function loadIncomplete(profileIds) {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, email, phone, status, created_at')
    .eq('role', 'provider')
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load provider accounts — ${error.message}`);
  return (users || []).filter((u) => !profileIds.has(u.id));
}

router.get('/', async (req, res) => {
  const rawTab = req.query.tab || req.query.status || 'review';
  const tab = TABS.includes(rawTab) ? rawTab : LEGACY_TAB[rawTab] || 'review';
  const search = sanitizeSearch(req.query.search);

  // One cheap read of every profile's status drives the tab counts and
  // the incomplete-signup diff.
  const { data: allStatuses, error: statusErr } = await supabase
    .from('provider_profiles')
    .select('user_id, application_status');
  if (statusErr) throw new Error(`Could not load providers — ${statusErr.message}`);

  const profileIds = new Set((allStatuses || []).map((r) => r.user_id));
  const byStatus = countBy(allStatuses || [], 'application_status');
  const incompleteAccounts = await loadIncomplete(profileIds);

  const counts = {
    review: REVIEW_STATUSES.reduce((n, s) => n + (byStatus[s] || 0), 0),
    incomplete: incompleteAccounts.length,
    approved: byStatus.approved || 0,
    rejected: byStatus.rejected || 0,
    suspended: byStatus.suspended || 0,
    all: (allStatuses || []).length,
  };

  if (tab === 'incomplete') {
    const rows = search
      ? incompleteAccounts.filter((u) => (u.email || '').toLowerCase().includes(search.toLowerCase()))
      : incompleteAccounts;
    return res.render('providers/index', { tab, counts, search, providers: [], incomplete: rows, rupees });
  }

  let q = supabase
    .from('provider_profiles')
    .select(
      'user_id, full_name, professional_title, years_experience, base_session_rate, license_no, bio, photo_url, ' +
        'education_credentials, application_status, kyc_status, profile_completed_by_provider, created_at, updated_at, approved_at',
    )
    .order(tab === 'review' ? 'updated_at' : 'created_at', { ascending: tab === 'review' });

  if (tab === 'review') q = q.in('application_status', REVIEW_STATUSES);
  else if (tab !== 'all') q = q.eq('application_status', tab);

  let emailMatchIds = null;
  if (search) {
    if (search.includes('@')) {
      const { data: matches } = await supabase.from('users').select('id').ilike('email', `%${search}%`).limit(50);
      emailMatchIds = (matches || []).map((m) => m.id);
      if (!emailMatchIds.length) emailMatchIds = ['00000000-0000-0000-0000-000000000000'];
      q = q.in('user_id', emailMatchIds);
    } else {
      q = q.or(`full_name.ilike.%${search}%,license_no.ilike.%${search}%,professional_title.ilike.%${search}%`);
    }
  }

  const { data: providers, error } = await q;
  if (error) throw new Error(`Could not load providers — ${error.message}`);

  const ids = (providers || []).map((p) => p.user_id);
  let emailById = {};
  let specCount = {};
  let langCount = {};
  if (ids.length) {
    const [{ data: users }, { data: specs }, { data: langs }] = await Promise.all([
      supabase.from('users').select('id, email, status').in('id', ids),
      supabase.from('provider_specialties').select('provider_id').in('provider_id', ids),
      supabase.from('provider_languages').select('provider_id').in('provider_id', ids),
    ]);
    (users || []).forEach((u) => (emailById[u.id] = u));
    specCount = countBy(specs || [], 'provider_id');
    langCount = countBy(langs || [], 'provider_id');
  }

  const rows = (providers || []).map((p) => ({
    ...p,
    account: emailById[p.user_id] || null,
    check: readiness(p, { specialties: specCount[p.user_id] || 0, languages: langCount[p.user_id] || 0 }),
  }));

  res.render('providers/index', { tab, counts, search, providers: rows, incomplete: [], rupees });
});

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;

  const [{ data: profile }, { data: user }] = await Promise.all([
    supabase.from('provider_profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('users').select('id, email, phone, role, status, created_at, deleted_at').eq('id', userId).maybeSingle(),
  ]);

  if (!user && !profile) return res.status(404).render('errors/404', { layout: false, backHref: '/providers', backLabel: 'Back to providers' });

  let specialties = [];
  let languages = [];
  let approaches = [];
  let reviews = [];
  let stats = { total: 0, completed: 0, upcoming: 0, openSlots: 0 };

  if (profile) {
    const nowIso = new Date().toISOString();
    const [
      { data: ps },
      { data: pl },
      { data: pa },
      { data: rv },
      { count: total },
      { count: completed },
      { count: upcoming },
      { count: openSlots },
    ] = await Promise.all([
      supabase.from('provider_specialties').select('specialty_id').eq('provider_id', userId),
      supabase.from('provider_languages').select('language_id').eq('provider_id', userId),
      supabase.from('provider_approaches').select('approach_id').eq('provider_id', userId),
      supabase
        .from('provider_application_reviews')
        .select('id, decision, decision_reason, reviewed_by, reviewed_at')
        .eq('provider_id', userId)
        .order('reviewed_at', { ascending: false })
        .limit(20),
      supabase.from('sessions').select('id', { count: 'exact', head: true }).eq('provider_id', userId),
      supabase.from('sessions').select('id', { count: 'exact', head: true }).eq('provider_id', userId).eq('status', 'completed'),
      supabase
        .from('sessions')
        .select('id', { count: 'exact', head: true })
        .eq('provider_id', userId)
        .in('status', ['confirmed', 'pending_payment'])
        .gt('scheduled_start', nowIso),
      supabase
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('provider_id', userId)
        .eq('status', 'open')
        .gt('start_time', nowIso),
    ]);

    const nameLookup = async (table, idList) => {
      if (!idList.length) return [];
      const { data } = await supabase.from(table).select('id, name, is_custom, is_approved').in('id', idList);
      return data || [];
    };
    [specialties, languages, approaches] = await Promise.all([
      nameLookup('specialties', (ps || []).map((r) => r.specialty_id)),
      nameLookup('languages', (pl || []).map((r) => r.language_id)),
      nameLookup('therapeutic_approaches', (pa || []).map((r) => r.approach_id)),
    ]);

    reviews = rv || [];
    const reviewerIds = [...new Set(reviews.map((r) => r.reviewed_by).filter(Boolean))];
    if (reviewerIds.length) {
      const { data: reviewers } = await supabase.from('users').select('id, email').in('id', reviewerIds);
      const emailOf = Object.fromEntries((reviewers || []).map((r) => [r.id, r.email]));
      reviews = reviews.map((r) => ({ ...r, reviewer: emailOf[r.reviewed_by] || null }));
    }
    stats = { total: total || 0, completed: completed || 0, upcoming: upcoming || 0, openSlots: openSlots || 0 };
  }

  const check = readiness(profile, { specialties: specialties.length, languages: languages.length });
  const allowed = profile
    ? Object.keys(TRANSITIONS).filter((d) => TRANSITIONS[d].includes(profile.application_status))
    : [];

  res.render('providers/show', {
    title: profile ? profile.full_name : user.email,
    profile,
    user,
    specialties,
    languages,
    approaches,
    reviews,
    stats,
    check,
    allowed,
    rupees,
  });
});

router.post('/:userId/decision', async (req, res) => {
  const { userId } = req.params;
  // Older forms posted the status name rather than the verb.
  const legacy = { approved: 'approve', rejected: 'reject', suspended: 'suspend' };
  const decision = legacy[req.body.decision] || req.body.decision;
  const reason = req.body.reason || req.body.rejection_reason || '';
  const back = safeRedirect(req.body.return_to, `/providers/${userId}`);

  const result = await applyDecision(supabase, {
    userId,
    decision,
    reason,
    adminId: req.session.superAdmin.id,
  });

  if (!result.ok) {
    req.setFlash({ type: 'error', message: result.message });
    return res.redirect(back);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `provider.${result.to}`,
    targetTable: 'provider_profiles',
    targetId: userId,
    details: { from: result.from, to: result.to, reason: reason || null, email: result.email },
  });

  const verb = { approve: 'approved — now visible to clients', reject: 'rejected', suspend: 'suspended — hidden from clients' }[decision];
  req.setFlash({
    type: 'success',
    message: `${result.name || 'Provider'} ${verb}.${result.emailed ? ' They were emailed.' : ' (Email not sent — check SMTP; they still get the in-app notification.)'}`,
  });
  res.redirect(back);
});

/**
 * Nudge for someone who signed up but never finished (or never submitted)
 * their profile. Same copy whether or not a profile row exists.
 */
router.post('/:userId/remind', async (req, res) => {
  const { userId } = req.params;
  const back = safeRedirect(req.body.return_to, `/providers/${userId}`);

  const { data: user } = await supabase.from('users').select('id, email, role').eq('id', userId).maybeSingle();
  if (!user || !user.email) {
    req.setFlash({ type: 'error', message: 'No email on file for this account.' });
    return res.redirect(back);
  }
  const { data: profile } = await supabase
    .from('provider_profiles')
    .select('full_name')
    .eq('user_id', userId)
    .maybeSingle();

  const mail = await sendMail({
    to: user.email,
    subject: "Finish your provider profile — Where's My Therapist",
    html: `<p>Hi ${escapeHtml((profile && profile.full_name) || 'there')},</p>
      <p>Thanks for signing up as a provider on Where's My Therapist. Your profile isn't complete yet, so we can't review it.</p>
      <p>Log in with <strong>${escapeHtml(user.email)}</strong> and fill in your title, license/registration number, qualifications,
      a short bio, a photo, your session rate, specialties and languages. We review complete profiles quickly.</p>`,
  });

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'provider.reminder_sent',
    targetTable: 'users',
    targetId: userId,
    details: { email: user.email, delivered: Boolean(mail.ok) },
  });

  req.setFlash(
    mail.ok
      ? { type: 'success', message: `Reminder sent to ${user.email}.` }
      : { type: 'error', message: `Could not email ${user.email} — check the mailer logs.` },
  );
  res.redirect(back);
});

module.exports = router;
