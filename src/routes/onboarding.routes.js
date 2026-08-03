const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { sendMail } = require('../config/mailer');

const router = express.Router();
router.use(requireSuperAdmin);

// Only these are creatable here. super_admin is deliberately excluded —
// that's granted directly in the DB by design (see settings.routes.js's
// original comment), never through a web form.
const ASSIGNABLE_ROLES = ['support_agent', 'content_moderator', 'finance'];

router.get('/', (req, res) => {
  res.render('onboarding/index', { result: null });
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