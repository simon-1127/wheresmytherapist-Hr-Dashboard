const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { pickArray, toCsvArray, toIntOrNull } = require('../lib/forms');
const { sendMail } = require('../config/mailer');
const { uuidParams, normalizeEmail, isEmail, escapeHtml, dashboardUrl } = require('../lib/validate');

const router = express.Router();
router.use(requireSuperAdmin);
uuidParams(router, ['id', 'contactId'], '/organizations', 'Back to organizations');

const ORG_STATUSES = ['active', 'inactive', 'churned'];

/**
 * Moves employees who were on this org's tier back to free. Only touches
 * people whose current tier IS the org's tier, so someone who separately
 * paid for a plan isn't downgraded by their employer leaving.
 */
async function revertOrgTier(orgId, userIds) {
  if (!userIds.length) return;
  const { data: org } = await supabase.from('organizations').select('subscription_tier_id').eq('id', orgId).maybeSingle();
  let q = supabase.from('client_profiles').update({ subscription_tier: 'free' }).in('user_id', userIds);
  if (org && org.subscription_tier_id) q = q.eq('subscription_tier', org.subscription_tier_id);
  const { error } = await q;
  if (error) console.error('[organizations] tier revert failed:', error.message);
}

// ---------- List ----------

router.get('/', async (req, res) => {
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, company_name, industry, size_category, status, plan, contract_end, spoc_name')
    .order('created_at', { ascending: false });

  const { data: counts } = await supabase.from('organization_employees').select('org_id, status');
  const employeeCounts = {};
  (counts || []).forEach((row) => {
    employeeCounts[row.org_id] = employeeCounts[row.org_id] || { total: 0, active: 0 };
    employeeCounts[row.org_id].total += 1;
    if (row.status === 'active') employeeCounts[row.org_id].active += 1;
  });

  res.render('organizations/index', { orgs: orgs || [], employeeCounts });
});

// ---------- New / Create ----------

router.get('/new', (req, res) => {
  res.render('organizations/new', { values: {} });
});

router.post('/', async (req, res) => {
  const b = req.body;

  const payload = {
    company_name: b.company_name,
    website: b.website || null,
    industry: b.industry || null,
    employee_count: toIntOrNull(b.employee_count),
    locations: toCsvArray(b.locations),
    size_category: b.size_category || null,

    spoc_name: b.spoc_name || null,
    spoc_designation: b.spoc_designation || null,
    spoc_email: normalizeEmail(b.spoc_email) || null,
    spoc_phone: b.spoc_phone || null,

    goals: pickArray(b, 'goals'),
    challenge_ratings: {
      work_stress: toIntOrNull(b.rating_work_stress),
      burnout: toIntOrNull(b.rating_burnout),
      anxiety: toIntOrNull(b.rating_anxiety),
      employee_engagement: toIntOrNull(b.rating_employee_engagement),
      sleep_issues: toIntOrNull(b.rating_sleep_issues),
      workplace_conflicts: toIntOrNull(b.rating_workplace_conflicts),
    },

    eligible_employees: toIntOrNull(b.eligible_employees),
    departments_covered: toCsvArray(b.departments_covered),
    locations_covered: toCsvArray(b.locations_covered),
    employee_access_model: b.employee_access_model || null,
    session_cadence: b.session_cadence || null,
    session_cadence_custom: b.session_cadence === 'custom' ? b.session_cadence_custom : null,

    services_therapy: pickArray(b, 'services_therapy'),
    services_wellness: pickArray(b, 'services_wellness'),
    services_emergency: pickArray(b, 'services_emergency'),

    access_methods: pickArray(b, 'access_methods'),
    auth_method: b.auth_method || null,

    confidentiality_agreed: b.confidentiality_agreed === 'on',
    confidentiality_agreed_at: b.confidentiality_agreed === 'on' ? new Date().toISOString() : null,

    plan: b.plan || null,
    subscription_tier_id: b.subscription_tier_id || 'HR-Onboarding',
    general_doctor_feature_enabled: b.subscription_tier_id === 'HR-Onboarding',
    billing_address: b.billing_address || null,
    gst_number: b.gst_number || null,
    invoice_email: b.invoice_email || null,
    payment_terms: b.payment_terms || null,
    contract_start: b.contract_start || null,
    contract_end: b.contract_end || null,

    launch_date: b.launch_date || null,
    communication_preference: pickArray(b, 'communication_preference'),
    logo_url: b.logo_url || null,
    hr_communication_guidelines_url: b.hr_communication_guidelines_url || null,

    status: 'active',
    created_by: req.session.superAdmin.id,
  };

  const { data: org, error } = await supabase
    .from('organizations')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('[organizations] create failed:', error);
    return res.render('organizations/new', {
      values: b,
      error: 'Could not save that organization — ' + error.message,
    });
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'organization.created',
    targetTable: 'organizations',
    targetId: org.id,
    details: { company_name: org.company_name },
  });

  let tempPasswordToShow = null;
  let hrProblem = null;
  const spocEmail = normalizeEmail(b.spoc_email);

  if (b.create_hr_access === 'on' && spocEmail && !isEmail(spocEmail)) {
    hrProblem = `HR portal access was NOT created — "${spocEmail}" isn't a valid email. Add the contact from the HR tab.`;
  } else if (b.create_hr_access === 'on' && spocEmail) {
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const { error: hrErr } = await supabase.from('organization_hr_contacts').insert({
      org_id: org.id,
      name: b.spoc_name || null,
      designation: b.spoc_designation || null,
      email: spocEmail,
      phone: b.spoc_phone || null,
      password_hash: passwordHash,
      must_reset_password: true,
      created_by: req.session.superAdmin.id,
    });

    if (!hrErr) {
      tempPasswordToShow = tempPassword;
      // The login link used to be built from EMPLOYEE_REDIRECT_URL — the
      // app's deep link (wheresmytherapist://…) — so it pointed nowhere.
      await sendMail({
        to: spocEmail,
        subject: "Your Where's My Therapist HR portal access",
        html: `<p>Hi ${escapeHtml(b.spoc_name || '')},</p>
          <p>An HR portal account has been created for ${escapeHtml(b.company_name)} at Where's My Therapist.</p>
          <p>Login email: <strong>${escapeHtml(spocEmail)}</strong><br/>
          Temporary password: <strong>${tempPassword}</strong></p>
          <p>You'll be asked to set your own password on first login.</p>
          <p><a href="${dashboardUrl()}/hr/login">Log in to the HR portal</a></p>`,
      });
    } else {
      console.error('[organizations] HR contact create failed:', hrErr);
      hrProblem =
        hrErr.code === '23505'
          ? `HR portal access was NOT created — ${spocEmail} is already an HR contact (emails are unique across all organizations).`
          : `HR portal access was NOT created — ${hrErr.message}`;
    }
  }

  // Previously a failed HR-contact insert still reported plain success, and
  // the SPOC simply never got access.
  req.setFlash(
    hrProblem
      ? { type: 'error', message: `Organization created. ${hrProblem}` }
      : tempPasswordToShow
        ? {
            type: 'success',
            message: `Organization created. HR contact temp password (shown once): ${tempPasswordToShow}`,
          }
        : { type: 'success', message: 'Organization created.' },
  );

  res.redirect(`/organizations/${org.id}`);
});

// ---------- Show ----------

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: org } = await supabase.from('organizations').select('*').eq('id', id).maybeSingle();
  if (!org) return res.status(404).render('errors/404', { layout: false, backHref: '/organizations', backLabel: 'Back to organizations' });

  const { data: hrContacts } = await supabase
    .from('organization_hr_contacts')
    .select('id, name, designation, email, phone, status, must_reset_password, last_login_at')
    .eq('org_id', id);

  const { data: employees } = await supabase
    .from('organization_employees')
    .select('id, email, status, invited_at, joined_at, user_id')
    .eq('org_id', id)
    .order('invited_at', { ascending: false });

  const { data: leaveRequests } = await supabase
    .from('organization_leave_requests')
    .select('id, employee_id, start_date, end_date, reason, status, created_at')
    .eq('org_id', id)
    .order('created_at', { ascending: false });

  res.render('organizations/show', {
    org,
    hrContacts: hrContacts || [],
    employees: employees || [],
    leaveRequests: leaveRequests || [],
    tab: req.query.tab || 'profile',
  });
});

// ---------- Update status (activate / deactivate / end contract) ----------

router.post('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!ORG_STATUSES.includes(status)) {
    req.setFlash({ type: 'error', message: 'Unknown status.' });
    return res.redirect(`/organizations/${id}`);
  }
  const { error: statusErr } = await supabase.from('organizations').update({ status }).eq('id', id);
  if (statusErr) {
    req.setFlash({ type: 'error', message: 'Could not update status — ' + statusErr.message });
    return res.redirect(`/organizations/${id}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `organization.status.${status}`,
    targetTable: 'organizations',
    targetId: id,
  });

  // Deactivating/churning an org automatically deactivates its employees and
  // reverts anyone with a linked user_id back to the free tier — per "should
  // be automatic" for tier reversion once the org relationship ends.
  if (status === 'inactive' || status === 'churned') {
    const { data: employees } = await supabase
      .from('organization_employees')
      .select('id, user_id')
      .eq('org_id', id)
      .eq('status', 'active');

    const employeeIds = (employees || []).map((e) => e.id);
    const userIds = (employees || []).filter((e) => e.user_id).map((e) => e.user_id);

    if (employeeIds.length) {
      await supabase
        .from('organization_employees')
        .update({ status: 'inactive', deactivated_at: new Date().toISOString() })
        .in('id', employeeIds);
    }
    await revertOrgTier(id, userIds);

    // HR contacts of an org that has ended shouldn't keep portal access.
    await supabase.from('organization_hr_contacts').update({ status: 'disabled' }).eq('org_id', id);

    await logAction({
      adminId: req.session.superAdmin.id,
      action: 'organization.employees.bulk_deactivated',
      targetTable: 'organizations',
      targetId: id,
      details: { count: employeeIds.length },
    });
    req.setFlash({
      type: 'success',
      message: `Organization ${status}. ${employeeIds.length} employee(s) deactivated and moved back to the free tier; HR portal logins disabled.`,
    });
  } else {
    req.setFlash({ type: 'success', message: `Organization ${status}. HR contacts can be re-enabled from the HR tab if needed.` });
  }

  res.redirect(`/organizations/${id}`);
});

// ---------- Manual bulk-delete-all-employees button ----------

router.post('/:id/employees/delete-all', async (req, res) => {
  const { id } = req.params;

  const { data: employees } = await supabase
    .from('organization_employees')
    .select('id, user_id, email')
    .eq('org_id', id);

  const userIds = (employees || []).filter((e) => e.user_id).map((e) => e.user_id);

  if (userIds.length) {
    // Soft-delete: keep the row (basic details for logs) but mark it gone,
    // matching how the rest of the app soft-deletes via account_status.
    await supabase
      .from('users')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .in('id', userIds);
    await revertOrgTier(id, userIds);
  }

  await supabase
    .from('organization_employees')
    .update({ status: 'inactive', deactivated_at: new Date().toISOString() })
    .eq('org_id', id);

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'organization.employees.bulk_deleted',
    targetTable: 'organizations',
    targetId: id,
    details: { count: (employees || []).length },
  });

  req.setFlash({ type: 'success', message: 'All employees for this organization were removed.' });
  res.redirect(`/organizations/${id}`);
});

// ---------- HR contact management ----------

router.post('/:id/hr-contacts', async (req, res) => {
  const { id } = req.params;
  const { name, designation, phone } = req.body;
  const email = normalizeEmail(req.body.email);
  if (!isEmail(email)) {
    req.setFlash({ type: 'error', message: 'Enter a valid email for the HR contact.' });
    return res.redirect(`/organizations/${id}?tab=hr`);
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const { error } = await supabase.from('organization_hr_contacts').insert({
    org_id: id,
    name: name || null,
    designation: designation || null,
    email,
    phone: phone || null,
    password_hash: passwordHash,
    must_reset_password: true,
    created_by: req.session.superAdmin.id,
  });

  if (error) {
    req.setFlash({
      type: 'error',
      message:
        error.code === '23505'
          ? `${email} is already an HR contact (possibly for another organization). Use "Reissue password" on the existing contact instead.`
          : 'Could not add HR contact — ' + error.message,
    });
    return res.redirect(`/organizations/${id}?tab=hr`);
  }

  await sendMail({
    to: email,
    subject: "Your Where's My Therapist HR portal access",
    html: `<p>Hi ${escapeHtml(name || '')},</p>
      <p>Login email: <strong>${escapeHtml(email)}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
      <p>You'll be asked to set your own password on first login.</p>
      <p><a href="${dashboardUrl()}/hr/login">Log in to the HR portal</a></p>`,
  });

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'hr_contact.created',
    targetTable: 'organization_hr_contacts',
    targetId: id,
    details: { email },
  });

  req.setFlash({
    type: 'success',
    message: `HR contact added. Temp password (shown once): ${tempPassword}`,
  });
  res.redirect(`/organizations/${id}?tab=hr`);
});

router.post('/:id/hr-contacts/:contactId/disable', async (req, res) => {
  const { id, contactId } = req.params;
  const { error } = await supabase
    .from('organization_hr_contacts')
    .update({ status: 'disabled' })
    .eq('id', contactId)
    .eq('org_id', id);
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not disable — ' + error.message });
    return res.redirect(`/organizations/${id}?tab=hr`);
  }
  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'hr_contact.disabled',
    targetTable: 'organization_hr_contacts',
    targetId: contactId,
  });
  req.setFlash({ type: 'success', message: 'HR contact disabled. Any open session ends within 5 minutes.' });
  res.redirect(`/organizations/${id}?tab=hr`);
});

// A temp password is shown exactly once, at creation. If it is lost —
// missed flash, undelivered mail, contact changed jobs — there was no way
// back: organization_hr_contacts.email is UNIQUE, so the same address
// cannot simply be added again. This reissues instead.
router.post('/:id/hr-contacts/:contactId/reissue-password', async (req, res) => {
  const { id, contactId } = req.params;

  const { data: contact } = await supabase
    .from('organization_hr_contacts')
    .select('id, email, name, org_id')
    .eq('id', contactId)
    .eq('org_id', id)
    .maybeSingle();

  if (!contact) {
    req.setFlash({ type: 'error', message: 'No such HR contact for this organization.' });
    return res.redirect(`/organizations/${id}?tab=hr`);
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const { error } = await supabase
    .from('organization_hr_contacts')
    .update({ password_hash: passwordHash, must_reset_password: true })
    .eq('id', contactId);

  if (error) {
    req.setFlash({ type: 'error', message: 'Could not reissue the password — ' + error.message });
    return res.redirect(`/organizations/${id}?tab=hr`);
  }

  try {
    await sendMail({
      to: contact.email,
      subject: "Your Where's My Therapist HR portal password was reset",
      html: `<p>Hi ${escapeHtml(contact.name || '')},</p>
        <p>A new temporary password has been issued for your HR portal account.</p>
        <p>Login email: <strong>${escapeHtml(contact.email)}</strong><br/>
        Temporary password: <strong>${tempPassword}</strong></p>
        <p>You'll be asked to set your own password on first login. Any previous password no longer works.</p>
        <p><a href="${dashboardUrl()}/hr/login">Log in to the HR portal</a></p>`,
    });
  } catch (err) {
    // The password has already changed at this point, so a mail failure
    // must not look like the whole thing failed — the flash below still
    // shows the value, which is the reliable channel anyway.
    console.error('[organizations] HR reissue email failed:', err);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'hr_contact.password_reissued',
    targetTable: 'organization_hr_contacts',
    targetId: contactId,
    details: { email: contact.email },
  });

  req.setFlash({
    type: 'success',
    message: `New temp password for ${contact.email} (shown once): ${tempPassword}`,
  });
  res.redirect(`/organizations/${id}?tab=hr`);
});

// Disable had no counterpart, which left an accidentally disabled contact
// permanently locked out for the same UNIQUE-email reason.
router.post('/:id/hr-contacts/:contactId/enable', async (req, res) => {
  const { id, contactId } = req.params;
  await supabase.from('organization_hr_contacts').update({ status: 'active' }).eq('id', contactId).eq('org_id', id);
  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'hr_contact.enabled',
    targetTable: 'organization_hr_contacts',
    targetId: contactId,
  });
  req.setFlash({ type: 'success', message: 'HR contact re-enabled.' });
  res.redirect(`/organizations/${id}?tab=hr`);
});

module.exports = router;
