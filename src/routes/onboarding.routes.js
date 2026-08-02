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
  const { email, role_type } = req.body;

  if (!ASSIGNABLE_ROLES.includes(role_type)) {
    req.setFlash({ type: 'error', message: 'Not a valid role for this form.' });
    return res.redirect('/onboarding');
  }

  const tempPassword = generateTempPassword();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not create account — ' + error.message });
    return res.redirect('/onboarding');
  }

  const { error: roleErr } = await supabase.from('admin_roles').insert({
    user_id: data.user.id,
    role_type,
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
      html: `<p>Login email: <strong>${email}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
        <p>Sign in at ${process.env.SUPPORT_DASHBOARD_URL}/support/login</p>`,
    });
  } catch (err) {
    console.error('[onboarding] team member invite email failed:', err);
  }

  req.setFlash({
    type: 'success',
    message: `${role_type.replace('_', ' ')} added. Temp password (shown once): ${tempPassword}`,
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
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not create provider — ' + error.message });
    return res.redirect('/onboarding');
  }

  // professional_title, years_experience, base_session_rate are NOT NULL
  // with no default — placeholder values here, provider fills in real ones
  // when they complete their profile. application_status stays 'draft'
  // (the actual DB default) since nothing's been submitted yet — this also
  // correctly keeps them out of the pending-review queue until they do.
  await supabase.from('provider_profiles').insert({
    user_id: data.user.id,
    full_name,
    professional_title: 'Not yet provided',
    years_experience: 0,
    base_session_rate: 1,
    application_status: 'draft',
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
