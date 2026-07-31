const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { toArray, toCsvArray, toIntOrNull } = require('../lib/forms');
const { sendMail } = require('../config/mailer');

const router = express.Router();
router.use(requireSuperAdmin);

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
    spoc_email: b.spoc_email || null,
    spoc_phone: b.spoc_phone || null,

    goals: toArray(b['goals[]']),
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

    services_therapy: toArray(b['services_therapy[]']),
    services_wellness: toArray(b['services_wellness[]']),
    services_emergency: toArray(b['services_emergency[]']),

    access_methods: toArray(b['access_methods[]']),
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
    communication_preference: toArray(b['communication_preference[]']),
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

  if (b.create_hr_access === 'on' && b.spoc_email) {
    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const { error: hrErr } = await supabase.from('organization_hr_contacts').insert({
      org_id: org.id,
      name: b.spoc_name || null,
      designation: b.spoc_designation || null,
      email: b.spoc_email,
      phone: b.spoc_phone || null,
      password_hash: passwordHash,
      must_reset_password: true,
      created_by: req.session.superAdmin.id,
    });

    if (!hrErr) {
      tempPasswordToShow = tempPassword;
      await sendMail({
        to: b.spoc_email,
        subject: "Your Where's My Therapist HR portal access",
        html: `<p>Hi ${b.spoc_name || ''},</p>
          <p>An HR portal account has been created for ${b.company_name} at Where's My Therapist.</p>
          <p>Login email: <strong>${b.spoc_email}</strong><br/>
          Temporary password: <strong>${tempPassword}</strong></p>
          <p>You'll be asked to set your own password on first login.</p>
          <p><a href="${process.env.EMPLOYEE_REDIRECT_URL ? process.env.EMPLOYEE_REDIRECT_URL.replace('/auth/callback', '') : ''}/hr/login">Log in to the HR portal</a></p>`,
      });
    } else {
      console.error('[organizations] HR contact create failed:', hrErr);
    }
  }

  req.setFlash(
    tempPasswordToShow
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

  const { data: org } = await supabase.from('organizations').select('*').eq('id', id).single();
  if (!org) return res.status(404).render('errors/404', { layout: false });

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

  await supabase.from('organizations').update({ status }).eq('id', id);

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
    if (userIds.length) {
      await supabase.from('client_profiles').update({ subscription_tier: 'free' }).in('user_id', userIds);
    }

    await logAction({
      adminId: req.session.superAdmin.id,
      action: 'organization.employees.bulk_deactivated',
      targetTable: 'organizations',
      targetId: id,
      details: { count: employeeIds.length },
    });
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
    await supabase.from('client_profiles').update({ subscription_tier: 'free' }).in('user_id', userIds);
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
  const { name, designation, email, phone } = req.body;

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
    req.setFlash({ type: 'error', message: 'Could not add HR contact — ' + error.message });
    return res.redirect(`/organizations/${id}`);
  }

  await sendMail({
    to: email,
    subject: "Your Where's My Therapist HR portal access",
    html: `<p>Login email: <strong>${email}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
      <p>You'll be asked to set your own password on first login.</p>`,
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
  res.redirect(`/organizations/${id}`);
});

router.post('/:id/hr-contacts/:contactId/disable', async (req, res) => {
  const { id, contactId } = req.params;
  await supabase.from('organization_hr_contacts').update({ status: 'disabled' }).eq('id', contactId);
  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'hr_contact.disabled',
    targetTable: 'organization_hr_contacts',
    targetId: contactId,
  });
  res.redirect(`/organizations/${id}`);
});

module.exports = router;
