const express = require('express');
const { supabase } = require('../config/supabase');
const { requireHrContact } = require('../middleware/auth');
const { sendMail } = require('../config/mailer');

const router = express.Router();

// Auth routes (login/logout/reset-password) live in auth.routes.js at
// /hr/login etc. Everything below requires an active HR contact session,
// and every query is filtered by their own org_id — never trust anything
// org-related from the request itself.
router.use(requireHrContact);

/**
 * Generates a Supabase magic link and emails it. The link lands the
 * employee in the CONSUMER app (EMPLOYEE_REDIRECT_URL), not this portal,
 * and creates the auth.users row (and public.users, via the trigger) if
 * the person doesn't have an account yet.
 *
 * Returns {ok} rather than throwing: an undelivered invite must not lose
 * the organization_employees row, and HR needs to be told which addresses
 * failed rather than shown a blanket success.
 */
async function sendEmployeeInvite(email) {
  try {
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: process.env.EMPLOYEE_REDIRECT_URL },
    });
    if (linkErr || !linkData) {
      console.error('[hr-portal] magic link generation failed for', email, linkErr);
      return { ok: false, reason: 'link' };
    }

    // Mirror the auth user into public.users ourselves rather than trusting
    // handle_new_auth_user's trigger to have fired.
    //
    // Everything downstream keys off this row: client_profiles.user_id has
    // an FK to it, so without it the employee signs in fine, reaches "Tell
    // us about yourself", and the profile insert dies with a 23503 they
    // can't do anything about. This is idempotent — ignoreDuplicates leaves
    // an existing row (and its role) untouched, so it is safe whether or
    // not the trigger also ran.
    if (linkData.user && linkData.user.id) {
      const { error: mirrorErr } = await supabase
        .from('users')
        .upsert(
          { id: linkData.user.id, email, role: 'client' },
          { onConflict: 'id', ignoreDuplicates: true },
        );
      if (mirrorErr) {
        console.error('[hr-portal] could not mirror public.users row for', email, mirrorErr.message);
        return { ok: false, reason: 'user_row' };
      }
    }
    const result = await sendMail({
      to: email,
      subject: "You're invited to Where's My Therapist",
      html: `<p>Your employer has set you up with access to Where's My Therapist.</p>
        <p><a href="${linkData.properties.action_link}">Click here to get started</a></p>`,
    });
    return result.ok ? { ok: true } : { ok: false, reason: 'mail' };
  } catch (err) {
    console.error('[hr-portal] invite failed for', email, err);
    return { ok: false, reason: 'error' };
  }
}

router.get('/', async (req, res) => {
  const orgId = req.session.hrContact.orgId;

  const { data: org } = await supabase.from('organizations').select('*').eq('id', orgId).single();

  const { count: totalEmployees } = await supabase
    .from('organization_employees')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);

  const { count: activeEmployees } = await supabase
    .from('organization_employees')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'active');

  const { count: pendingLeave } = await supabase
    .from('organization_leave_requests')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'pending');

  res.render('hrPortal/dashboard', {
    org,
    stats: {
      totalEmployees: totalEmployees || 0,
      activeEmployees: activeEmployees || 0,
      pendingLeave: pendingLeave || 0,
    },
    layout: 'partials/hrLayout',
  });
});

// ---------- Employees ----------

router.get('/employees', async (req, res) => {
  const orgId = req.session.hrContact.orgId;
  const { data: employees } = await supabase
    .from('organization_employees')
    .select('id, email, status, invited_at, joined_at')
    .eq('org_id', orgId)
    .order('invited_at', { ascending: false });

  res.render('hrPortal/employees', { employees: employees || [], layout: 'partials/hrLayout' });
});

router.post('/employees', async (req, res) => {
  const orgId = req.session.hrContact.orgId;
  const { emails } = req.body;

  const list = String(emails || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let added = 0;
  const notEmailed = [];
  const notAdded = [];

  for (const email of list) {
    const { error } = await supabase.from('organization_employees').insert({
      org_id: orgId,
      email,
      added_by_hr_contact_id: req.session.hrContact.id,
    });
    if (error) {
      // Almost always a duplicate. Previously these vanished into the
      // "3 of 5 added" count with no indication of which two.
      notAdded.push(email);
      continue;
    }
    added += 1;

    const invite = await sendEmployeeInvite(email);
    if (!invite.ok) notEmailed.push(email);
  }

  // A row without a delivered invite is a person who will never hear about
  // this, so it must not be reported as a plain success.
  const parts = [`${added} of ${list.length} employee(s) added.`];
  if (notAdded.length) parts.push(`Already on the list (skipped): ${notAdded.join(', ')}.`);
  if (notEmailed.length) {
    parts.push(`Invite email could NOT be sent to: ${notEmailed.join(', ')} — use "Resend invite" once email is working.`);
  }

  req.setFlash({
    type: notEmailed.length || notAdded.length ? 'error' : 'success',
    message: parts.join(' '),
  });
  res.redirect('/hr/employees');
});

// Invites that failed to send — or expired, since Supabase magic links are
// short-lived — had no recovery path short of removing and re-adding the
// employee. This reissues a fresh link against the existing row.
router.post('/employees/:employeeId/resend-invite', async (req, res) => {
  const orgId = req.session.hrContact.orgId;

  const { data: employee } = await supabase
    .from('organization_employees')
    .select('id, email, status')
    .eq('id', req.params.employeeId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (!employee) {
    req.setFlash({ type: 'error', message: 'No such employee.' });
    return res.redirect('/hr/employees');
  }

  const invite = await sendEmployeeInvite(employee.email);
  req.setFlash(
    invite.ok
      ? { type: 'success', message: `Invite re-sent to ${employee.email}.` }
      : { type: 'error', message: `Could not send to ${employee.email} — check the mailer logs.` },
  );
  res.redirect('/hr/employees');
});

router.post('/employees/:employeeId/remove', async (req, res) => {
  const orgId = req.session.hrContact.orgId;
  const { employeeId } = req.params;

  await supabase
    .from('organization_employees')
    .update({ status: 'inactive', deactivated_at: new Date().toISOString() })
    .eq('id', employeeId)
    .eq('org_id', orgId);

  res.redirect('/hr/employees');
});

// ---------- Leave requests (UI only — no approval workflow wired up yet) ----------

router.get('/leave-requests', async (req, res) => {
  const orgId = req.session.hrContact.orgId;

  const { data: employees } = await supabase
    .from('organization_employees')
    .select('id, email')
    .eq('org_id', orgId);

  const { data: leaveRequests } = await supabase
    .from('organization_leave_requests')
    .select('id, employee_id, start_date, end_date, reason, status, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  const employeesById = {};
  (employees || []).forEach((e) => (employeesById[e.id] = e.email));

  res.render('hrPortal/leaveRequests', {
    employees: employees || [],
    leaveRequests: leaveRequests || [],
    employeesById,
    layout: 'partials/hrLayout',
  });
});

router.post('/leave-requests', async (req, res) => {
  const orgId = req.session.hrContact.orgId;
  const { employee_id, start_date, end_date, reason } = req.body;

  await supabase.from('organization_leave_requests').insert({
    org_id: orgId,
    employee_id,
    start_date,
    end_date,
    reason: reason || null,
  });

  res.redirect('/hr/leave-requests');
});

// ---------- Reports (Step 7 — aggregate only, nothing employee-identifiable) ----------

router.get('/reports', async (req, res) => {
  const orgId = req.session.hrContact.orgId;
  const { count: totalEmployees } = await supabase
    .from('organization_employees')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);

  res.render('hrPortal/reports', { totalEmployees: totalEmployees || 0, layout: 'partials/hrLayout' });
});

module.exports = router;
