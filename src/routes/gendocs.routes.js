const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { sendMail } = require('../config/mailer');
const { toArray } = require('../lib/forms');

const router = express.Router();
router.use(requireSuperAdmin);

// General doctors exist ONLY through this dashboard. There is deliberately
// no self-signup path: a GenDoc is contracted by WMT to serve specific
// client organizations, so an open application queue (the way
// provider_profiles works) would make no sense here.
//
// The other structural difference from providers: no specialties, no
// approaches, no session rate, no KYC and no Razorpay anything. Orgs are
// billed out of band, so there is no money to move and nothing to verify
// for payouts.

// ---------------------------------------------------------------------
// List
// ---------------------------------------------------------------------

router.get('/', async (req, res) => {
  const filter = req.query.status || 'all';

  let q = supabase
    .from('gendoc_profiles')
    .select(
      `user_id, full_name, professional_title, registration_no, registration_council,
       years_experience, application_status, is_accepting_queue, consultation_minutes, created_at,
       gendoc_org_assignments(org_id, is_active, organizations(company_name))`,
    )
    .order('created_at', { ascending: false });

  if (filter === 'pending_review') {
    q = q.in('application_status', ['submitted', 'under_review']);
  } else if (filter !== 'all') {
    q = q.eq('application_status', filter);
  }

  const { data: gendocs, error } = await q;
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not load doctors — ' + error.message });
  }

  // Orgs eligible to be assigned a doctor. general_doctor_feature_enabled
  // is derived from the org's tier in organizations.routes.js, so this
  // list is exactly "orgs on the HR-Onboarding plan".
  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, company_name')
    .eq('general_doctor_feature_enabled', true)
    .eq('status', 'active')
    .order('company_name');

  res.render('gendocs/index', {
    gendocs: gendocs || [],
    orgs: orgs || [],
    filter,
  });
});

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { email, full_name, professional_title, registration_no, registration_council } = req.body;
  const tempPassword = generateTempPassword();

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not create doctor — ' + error.message });
    return res.redirect('/gendocs');
  }

  // handle_new_auth_user's trigger hardcodes role='client' for every new
  // auth user. Without this flip the account routes into the client half
  // of the app and the doctor never sees a queue — same trap the provider
  // onboarding route documents.
  const { error: roleError } = await supabase
    .from('users')
    .update({ role: 'gendoc' })
    .eq('id', data.user.id);

  if (roleError) {
    // Almost always means migrations/0008 hasn't been run, so 'gendoc' is
    // not yet a value of the user_role enum. Say so plainly rather than
    // leaving a half-created account behind with no explanation.
    await supabase.auth.admin.deleteUser(data.user.id).catch(() => {});
    req.setFlash({
      type: 'error',
      message:
        "Could not set the account role — has migrations/0008 been run? ('gendoc' must exist in the user_role enum.) " +
        roleError.message,
    });
    return res.redirect('/gendocs');
  }

  // Placeholder-shaped, exactly like the provider invite flow: the doctor
  // fills in the real values themselves. Both *_by_gendoc flags start
  // false so the app router sends them through password setup and the
  // profile form instead of straight to their dashboard with a temp
  // password they never changed.
  const { error: profileError } = await supabase.from('gendoc_profiles').insert({
    user_id: data.user.id,
    full_name,
    professional_title: professional_title || 'General Physician',
    registration_no: registration_no || null,
    registration_council: registration_council || null,
    application_status: 'draft',
    profile_completed_by_gendoc: false,
    password_set_by_gendoc: false,
  });

  if (profileError) {
    await supabase.auth.admin.deleteUser(data.user.id).catch(() => {});
    req.setFlash({ type: 'error', message: 'Could not create doctor profile — ' + profileError.message });
    return res.redirect('/gendocs');
  }

  // A sensible default schedule so the ETA engine has something to work
  // with the moment a doctor is assigned. They can change all of it from
  // the app.
  await supabase.from('gendoc_schedules').insert({ gendoc_id: data.user.id });

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'gendoc.created',
    targetTable: 'gendoc_profiles',
    targetId: data.user.id,
  });

  try {
    await sendMail({
      to: email,
      subject: "Doctor account created — Where's My Therapist",
      html: `<p>Login email: <strong>${email}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
        <p>You'll be asked to set your own password and complete your profile when you first log in.</p>`,
    });
  } catch (err) {
    console.error('[gendocs] invite email failed:', err);
  }

  req.setFlash({
    type: 'success',
    message: `Doctor account created. Temp password (shown once): ${tempPassword}`,
  });
  res.redirect('/gendocs');
});

// ---------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;

  const [{ data: gendoc }, { data: user }, { data: schedule }, { data: assignments }, { data: orgs }] =
    await Promise.all([
      supabase.from('gendoc_profiles').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('users').select('id, email, phone, status, created_at').eq('id', userId).maybeSingle(),
      supabase.from('gendoc_schedules').select('*').eq('gendoc_id', userId).maybeSingle(),
      supabase
        .from('gendoc_org_assignments')
        .select('org_id, is_active, assigned_at, organizations(id, company_name, status)')
        .eq('gendoc_id', userId),
      supabase
        .from('organizations')
        .select('id, company_name')
        .eq('general_doctor_feature_enabled', true)
        .eq('status', 'active')
        .order('company_name'),
    ]);

  if (!gendoc) return res.status(404).render('errors/404', { layout: false });

  // Today's queue, so an admin can see whether the doctor is actually
  // being used before anyone asks.
  const { data: queue } = await supabase
    .from('gendoc_queue_entries')
    .select('id, status, position, estimated_start, requested_at, client_id')
    .eq('gendoc_id', userId)
    .gte('requested_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('position');

  const assignedOrgIds = new Set((assignments || []).filter((a) => a.is_active).map((a) => a.org_id));

  res.render('gendocs/show', {
    gendoc,
    user: user || null,
    schedule: schedule || null,
    assignments: assignments || [],
    availableOrgs: (orgs || []).filter((o) => !assignedOrgIds.has(o.id)),
    queue: queue || [],
  });
});

// ---------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------

router.post('/:userId/decision', async (req, res) => {
  const { userId } = req.params;
  const { decision, rejection_reason } = req.body;

  const update = {
    application_status: decision,
    rejection_reason: decision === 'rejected' ? rejection_reason || null : null,
  };
  if (decision === 'approved') update.approved_at = new Date().toISOString();

  const { error } = await supabase.from('gendoc_profiles').update(update).eq('user_id', userId);
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not update doctor — ' + error.message });
    return res.redirect(`/gendocs/${userId}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `gendoc.${decision}`,
    targetTable: 'gendoc_profiles',
    targetId: userId,
  });

  // Unlike providers there is no kyc_status half to satisfy — approval on
  // its own makes the doctor visible, but only to employees of the orgs
  // they're assigned to (enforced by gendoc_profiles_select_org in RLS).
  req.setFlash({
    type: decision === 'approved' ? 'success' : 'info',
    message:
      decision === 'approved'
        ? 'Doctor approved. They are visible to employees of their assigned organizations.'
        : 'Doctor rejected.',
  });
  res.redirect(`/gendocs/${userId}`);
});

// ---------------------------------------------------------------------
// Org assignment — this is what makes a doctor org-exclusive
// ---------------------------------------------------------------------

router.post('/:userId/assignments', async (req, res) => {
  const { userId } = req.params;
  // Checkboxes arrive as a string when one is ticked and an array when
  // several are — toArray normalizes all three cases including none.
  const orgIds = toArray(req.body['org_id[]']).filter(Boolean);

  if (!orgIds.length) {
    req.setFlash({ type: 'error', message: 'Pick an organization first.' });
    return res.redirect(`/gendocs/${userId}`);
  }

  // Upsert rather than insert: re-adding an org that was previously
  // removed should reactivate the existing row, not collide with the
  // composite primary key.
  const { error } = await supabase.from('gendoc_org_assignments').upsert(
    orgIds.map((orgId) => ({
      gendoc_id: userId,
      org_id: orgId,
      assigned_by: req.session.superAdmin.id,
      is_active: true,
    })),
    { onConflict: 'gendoc_id,org_id' },
  );

  if (error) {
    req.setFlash({ type: 'error', message: 'Could not assign — ' + error.message });
    return res.redirect(`/gendocs/${userId}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'gendoc.org_assigned',
    targetTable: 'gendoc_org_assignments',
    targetId: userId,
    details: { org_ids: orgIds },
  });

  req.setFlash({ type: 'success', message: 'Organization assigned.' });
  res.redirect(`/gendocs/${userId}`);
});

router.post('/:userId/assignments/:orgId/remove', async (req, res) => {
  const { userId, orgId } = req.params;

  // Deactivated, not deleted — employees mid-queue keep a valid org_id on
  // their entry, and the assignment history stays auditable.
  const { error } = await supabase
    .from('gendoc_org_assignments')
    .update({ is_active: false })
    .eq('gendoc_id', userId)
    .eq('org_id', orgId);

  if (error) {
    req.setFlash({ type: 'error', message: 'Could not remove — ' + error.message });
    return res.redirect(`/gendocs/${userId}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'gendoc.org_unassigned',
    targetTable: 'gendoc_org_assignments',
    targetId: userId,
    details: { org_id: orgId },
  });

  req.setFlash({ type: 'success', message: 'Organization removed.' });
  res.redirect(`/gendocs/${userId}`);
});

// ---------------------------------------------------------------------
// Availability toggle
// ---------------------------------------------------------------------

router.post('/:userId/accepting', async (req, res) => {
  const { userId } = req.params;
  const accepting = req.body.accepting === 'true';

  await supabase.from('gendoc_profiles').update({ is_accepting_queue: accepting }).eq('user_id', userId);

  await logAction({
    adminId: req.session.superAdmin.id,
    action: accepting ? 'gendoc.queue_opened' : 'gendoc.queue_closed',
    targetTable: 'gendoc_profiles',
    targetId: userId,
  });

  req.setFlash({
    type: 'success',
    message: accepting ? 'Doctor is accepting consultations.' : 'Doctor is no longer accepting new requests.',
  });
  res.redirect(`/gendocs/${userId}`);
});

module.exports = router;
