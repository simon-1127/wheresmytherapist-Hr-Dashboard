const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { sendMail } = require('../config/mailer');

const router = express.Router();
router.use(requireSuperAdmin);

router.get('/', async (req, res) => {
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, company_name')
    .eq('status', 'active')
    .order('company_name', { ascending: true });

  res.render('onboarding/index', { orgs: orgs || [], result: null });
});

// ---------- Employee ----------
// Note: this doesn't replace the HR portal's own employee-add flow
// (routes/hrPortal.routes.js) — that already creates the account
// immediately via generateLink, no gap there. This exists so WMT can add
// an employee directly without going through an org's HR contact at all
// (e.g. org has no HR contact set up yet, or WMT is onboarding on their
// behalf).

router.post('/employees', async (req, res) => {
  const { email, org_id } = req.body;

  const { error } = await supabase.from('organization_employees').insert({
    org_id,
    email,
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not add employee — ' + error.message });
    return res.redirect('/onboarding');
  }

  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: process.env.EMPLOYEE_REDIRECT_URL },
    });
    if (!linkErr && linkData) {
      await sendMail({
        to: email,
        subject: "You're invited to Where's My Therapist",
        html: `<p>You've been set up with access to Where's My Therapist.</p>
          <p><a href="${linkData.properties.action_link}">Click here to get started</a></p>`,
      });
    }
  } catch (err) {
    console.error('[onboarding] magic link generation failed for', email, err);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'onboarding.employee.added',
    targetTable: 'organization_employees',
    targetId: org_id,
    details: { email },
  });

  req.setFlash({ type: 'success', message: `${email} added and invited.` });
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
