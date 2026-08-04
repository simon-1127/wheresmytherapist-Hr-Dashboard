const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { sendMail } = require('../config/mailer');
const {
  preflightUpgrade,
  upgradeToProvider,
  preflightRevert,
  revertToClient,
} = require('../lib/providerUpgrade');

const router = express.Router();
router.use(requireSuperAdmin);

// Only these are creatable here. super_admin is deliberately excluded —
// that's granted directly in the DB by design (see settings.routes.js's
// original comment), never through a web form.
const ASSIGNABLE_ROLES = ['support_agent', 'content_moderator', 'finance'];

router.get('/', (req, res) => {
  res.render('onboarding/index', { result: null });
});

// ---------- Upgrade an existing account to a provider ----------
// The other provider route below creates a brand new account. This is the
// case that previously required hand-written SQL: someone already signed up
// as a client (often a therapist who downloaded the app before there was a
// provider signup) who needs to become a provider without losing their
// login.

router.get('/upgrade', async (req, res) => {
  const search = (req.query.search || '').trim();
  let candidates = [];

  if (search) {
    // Two lookups because the name lives in client_profiles while the email
    // and phone live in users; results are merged and de-duplicated on id.
    const [{ data: byContact }, { data: byName }] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, phone, role, status, created_at')
        .eq('role', 'client')
        .is('deleted_at', null)
        .or(`email.ilike.%${search}%,phone.ilike.%${search}%`)
        .limit(25),
      supabase
        .from('client_profiles')
        .select('user_id, full_name, subscription_tier')
        .ilike('full_name', `%${search}%`)
        .limit(25),
    ]);

    const ids = new Set();
    (byContact || []).forEach((u) => ids.add(u.id));
    (byName || []).forEach((c) => ids.add(c.user_id));

    if (ids.size) {
      const [{ data: users }, { data: profiles }] = await Promise.all([
        supabase
          .from('users')
          .select('id, email, phone, role, status, created_at')
          .in('id', [...ids])
          .is('deleted_at', null),
        supabase.from('client_profiles').select('user_id, full_name, subscription_tier').in('user_id', [...ids]),
      ]);
      const profileById = {};
      (profiles || []).forEach((c) => (profileById[c.user_id] = c));
      candidates = (users || []).map((u) => ({ ...u, profile: profileById[u.id] || null }));
    }
  }

  res.render('onboarding/upgrade', { search, candidates });
});

router.get('/upgrade/:userId', async (req, res) => {
  const check = await preflightUpgrade(supabase, req.params.userId);
  if (!check.user) return res.status(404).render('errors/404', { layout: false });

  // Already a provider sitting on an untouched draft — offer the undo
  // instead of an upgrade that can't happen.
  let revert = null;
  if (check.user.role === 'provider') {
    revert = await preflightRevert(supabase, req.params.userId);
  }

  res.render('onboarding/upgradeReview', { check, revert });
});

router.post('/upgrade/:userId', async (req, res) => {
  const { userId } = req.params;
  const { full_name: fullNameInput, acknowledge } = req.body;

  // Re-run the checks at submit time rather than trusting the page the
  // admin was looking at — it may be minutes old, and a session could have
  // been booked in between.
  const check = await preflightUpgrade(supabase, userId);
  if (!check.user) return res.status(404).render('errors/404', { layout: false });

  if (check.blockers.length) {
    req.setFlash({ type: 'error', message: `Cannot upgrade: ${check.blockers[0]}` });
    return res.redirect(`/onboarding/upgrade/${userId}`);
  }
  if (check.warnings.length && acknowledge !== 'on') {
    req.setFlash({ type: 'error', message: 'Tick the acknowledgement box to continue.' });
    return res.redirect(`/onboarding/upgrade/${userId}`);
  }

  const fullName = (fullNameInput || '').trim() || (check.clientProfile && check.clientProfile.full_name) || 'Not yet provided';

  const result = await upgradeToProvider(supabase, { userId, fullName });
  if (!result.ok) {
    console.error('[onboarding] provider upgrade failed at', result.stage, result.message);
    req.setFlash({ type: 'error', message: `Upgrade failed (${result.stage}) — ${result.message}` });
    return res.redirect(`/onboarding/upgrade/${userId}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'onboarding.provider.upgraded_from_client',
    targetTable: 'provider_profiles',
    targetId: userId,
    details: {
      previous_role: check.user.role,
      email: check.user.email,
      warnings: check.warnings,
      notes: check.notes,
    },
  });

  try {
    await sendMail({
      to: check.user.email,
      subject: "Provider access enabled — Where's My Therapist",
      html: `<p>Your existing account (<strong>${check.user.email}</strong>) now has provider access.</p>
        <p>Sign in with the same password you already use — nothing about your login has changed.
        You'll be asked to complete your provider profile, and it'll be reviewed once you submit it.</p>`,
    });
  } catch (err) {
    console.error('[onboarding] provider upgrade email failed:', err);
  }

  req.setFlash({
    type: 'success',
    message: `${fullName} is now a provider. They keep their existing login and will be prompted to complete their profile.`,
  });
  res.redirect('/providers?status=all');
});

router.post('/upgrade/:userId/revert', async (req, res) => {
  const { userId } = req.params;
  const revert = await preflightRevert(supabase, userId);

  if (revert.blockers.length) {
    req.setFlash({ type: 'error', message: `Cannot revert: ${revert.blockers[0]}` });
    return res.redirect(`/onboarding/upgrade/${userId}`);
  }

  const result = await revertToClient(supabase, userId);
  if (!result.ok) {
    req.setFlash({ type: 'error', message: `Revert failed (${result.stage}) — ${result.message}` });
    return res.redirect(`/onboarding/upgrade/${userId}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'onboarding.provider.reverted_to_client',
    targetTable: 'users',
    targetId: userId,
  });

  req.setFlash({ type: 'success', message: 'Reverted to client.' });
  res.redirect(`/onboarding/upgrade/${userId}`);
});

// ---------- WMT team members ----------
// Note: this is NOT for organization employees — orgs add their own
// employees themselves via their SPOC/HR-contact login (see
// routes/hrPortal.routes.js). This is only for WMT's own internal staff
// getting an admin_roles-based role.

router.post('/team-members', async (req, res) => {
  const { email, role_type, full_name, password } = req.body;

  if (!ASSIGNABLE_ROLES.includes(role_type)) {
    req.setFlash({ type: 'error', message: 'Not a valid role for this form.' });
    return res.redirect('/onboarding');
  }

  // Set directly by the admin rather than auto-generated — there's no
  // self-serve password reset for the dashboard yet (support_agent/
  // content_moderator/finance don't have one; HR contacts do, via
  // /hr/reset-password, but that's a separate system entirely), so a lost
  // auto-generated password had no recovery path short of deleting and
  // recreating the account. A real reset flow for the dashboard is planned
  // separately; this is the interim.
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // Populates the "Display Name" column in Supabase's own Authentication >
    // Users list, which reads from raw_user_meta_data — admin_roles.full_name
    // (below) is a separate table Supabase's own dashboard has no visibility
    // into, so storing the name there alone never showed up there.
    user_metadata: { full_name },
  });
  if (error) {
    console.error('[onboarding] createUser failed:', error);
    const msg = error.message || error.error_description || 'Unknown error — check server logs.';
    req.setFlash({ type: 'error', message: 'Could not create account — ' + msg });
    return res.redirect('/onboarding');
  }

  const { error: roleErr } = await supabase.from('admin_roles').insert({
    user_id: data.user.id,
    role_type,
    full_name,
    granted_by: req.session.superAdmin.id,
  });
  if (roleErr) {
    req.setFlash({ type: 'error', message: 'Account created but role assignment failed — ' + roleErr.message });
    return res.redirect('/onboarding');
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `team_member.created.${role_type}`,
    targetTable: 'admin_roles',
    targetId: data.user.id,
  });

  try {
    await sendMail({
      to: email,
      subject: "Team access — Where's My Therapist",
      html: `<p>Login email: <strong>${email}</strong></p>
        <p>Sign in at ${process.env.SUPPORT_DASHBOARD_URL}/support/login — your admin will share your password with you directly.</p>`,
    });
  } catch (err) {
    console.error('[onboarding] team member invite email failed:', err);
  }

  req.setFlash({
    type: 'success',
    message: `${role_type.replace('_', ' ')} added.`,
  });
  res.redirect('/onboarding');
});

// ---------- Provider ----------
// This is the actual gap: providers currently only exist in this dashboard
// after they self-register and apply via the general app (see
// routes/providers.routes.js, which is review-only). This creates the
// account directly instead — provider fills in the rest of their profile
// themselves, and flows into the existing review queue as normal since
// application_status starts at 'submitted'.

router.post('/providers', async (req, res) => {
  const { email, full_name } = req.body;
  const tempPassword = generateTempPassword();

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    // Same fix as team-members above — populates Supabase's own Auth >
    // Users "Display Name" column, which provider_profiles.full_name alone
    // (a separate table) was never visible to.
    user_metadata: { full_name },
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not create provider — ' + error.message });
    return res.redirect('/onboarding');
  }

  // handle_new_auth_user's trigger inserts public.users with role='client'
  // hardcoded for every new auth user — this flips it to 'provider'
  // immediately, same as the self-signup flow's markAsProvider() does
  // client-side. Without this the account is permanently misrouted as a
  // client (see app_router.dart's role gate).
  await supabase.from('users').update({ role: 'provider' }).eq('id', data.user.id);

  // professional_title, years_experience, base_session_rate are NOT NULL
  // with no default — placeholder values here, provider fills in real ones
  // when they complete their profile. application_status stays 'draft'
  // (the actual DB default) since nothing's been submitted yet — this also
  // correctly keeps them out of the pending-review queue until they do.
  // profile_completed_by_provider / password_set_by_provider: false — both
  // flip to true from the app side once the provider actually fills in
  // their real profile and sets their own password (see
  // migrations/0002 and 0007). Needed so the router sends them through
  // those steps instead of skipping straight to the KYC stub with
  // placeholder data and a temp password they never got to change.
  await supabase.from('provider_profiles').insert({
    user_id: data.user.id,
    full_name,
    professional_title: 'Not yet provided',
    years_experience: 0,
    base_session_rate: 1,
    application_status: 'draft',
    profile_completed_by_provider: false,
    password_set_by_provider: false,
  });

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'onboarding.provider.created',
    targetTable: 'provider_profiles',
    targetId: data.user.id,
  });

  try {
    await sendMail({
      to: email,
      subject: "Provider account created — Where's My Therapist",
      html: `<p>Login email: <strong>${email}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
        <p>Complete and submit your profile after logging in — it'll be reviewed once submitted.</p>`,
    });
  } catch (err) {
    console.error('[onboarding] provider invite email failed:', err);
  }

  req.setFlash({
    type: 'success',
    message: `Provider account created. Temp password (shown once): ${tempPassword}`,
  });
  res.redirect('/onboarding');
});

module.exports = router;