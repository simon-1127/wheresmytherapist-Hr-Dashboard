const express = require('express');
const { supabase } = require('../config/supabase');
const { requireHrContact } = require('../middleware/auth');
const { sendMail } = require('../config/mailer');
const { uuidParams, normalizeEmail, isEmail } = require('../lib/validate');

const router = express.Router();

// Auth routes (login/logout/reset-password) live in auth.routes.js at
// /hr/login etc. Everything below requires an active HR contact session,
// and every query is filtered by their own org_id — never trust anything
// org-related from the request itself.
router.use(requireHrContact);
uuidParams(router, ['employeeId'], '/hr/employees', 'Back to employees');

const MAX_BATCH = 500;

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

/**
 * Links an organization_employees row to an account that ALREADY exists.
 *
 * fn_link_org_employee_on_profile_create only fires on INSERT into
 * client_profiles, so it catches people who sign up AFTER being invited.
 * Anyone who already had an app account when HR added them keeps
 * user_id NULL and status 'invited' forever — and fn_my_org_ids() ignores
 * those rows. That single fact is why such an employee gets none of the
 * org's benefits: no org subscription tier, and general doctors stay
 * invisible to them (gendoc_profiles_select_org resolves through
 * fn_my_org_ids).
 *
 * Returns true only when this call actually linked a row.
 */
async function linkExistingEmployeeAccount(orgId, email) {
  const { data: user } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (!user) return false;

  // No profile yet means a brand-new account — leave it alone so the
  // trigger does the linking (and the tier assignment) on first save.
  const { data: profile } = await supabase
    .from('client_profiles')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!profile) return false;

  const { data: linked } = await supabase
    .from('organization_employees')
    .update({ user_id: user.id, status: 'active', joined_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('email', email)
    .is('user_id', null)
    .select('id');

  if (!linked || !linked.length) return false;

  // The trigger also copies the org's tier onto the profile; do the same
  // here so a pre-existing account isn't left on 'free'.
  const { data: org } = await supabase
    .from('organizations')
    .select('subscription_tier_id')
    .eq('id', orgId)
    .maybeSingle();
  if (org && org.subscription_tier_id) {
    await supabase
      .from('client_profiles')
      .update({ subscription_tier: org.subscription_tier_id })
      .eq('user_id', user.id);
  }

  return true;
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

  // Accepts one-per-line, or comma/semicolon separated (pasted from a
  // spreadsheet or an email "To:" line). Lowercased because the DB trigger
  // that links an invite to the person's account compares emails exactly,
  // and Supabase stores account emails lowercased — "Priya@Acme.com" never
  // linked before this.
  const tokens = String(emails || '')
    .split(/[\n,;]+/)
    .map((s) => normalizeEmail(s.replace(/^.*<([^>]+)>.*$/, '$1')))
    .filter(Boolean);
  const invalid = tokens.filter((e) => !isEmail(e));
  const list = [...new Set(tokens.filter((e) => isEmail(e)))];

  if (!list.length) {
    req.setFlash({
      type: 'error',
      message: invalid.length ? `No valid emails found. Check: ${invalid.slice(0, 10).join(', ')}` : 'Paste at least one email.',
    });
    return res.redirect('/hr/employees');
  }
  if (list.length > MAX_BATCH) {
    req.setFlash({ type: 'error', message: `Please add at most ${MAX_BATCH} emails at a time (you pasted ${list.length}).` });
    return res.redirect('/hr/employees');
  }

  let added = 0;
  let linkedExisting = 0;
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

    // Someone who already uses the app won't trip the profile-create
    // trigger, so link them here instead of leaving them 'invited'.
    if (await linkExistingEmployeeAccount(orgId, email)) linkedExisting += 1;
  }

  // A row without a delivered invite is a person who will never hear about
  // this, so it must not be reported as a plain success.
  const parts = [`${added} of ${list.length} employee(s) added.`];
  if (invalid.length) parts.push(`Not valid emails (skipped): ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? '…' : ''}.`);
  if (linkedExisting) parts.push(`${linkedExisting} already had an account and were activated immediately.`);
  if (notAdded.length) parts.push(`Already on the list (skipped): ${notAdded.join(', ')}.`);
  if (notEmailed.length) {
    parts.push(`Invite email could NOT be sent to: ${notEmailed.join(', ')} — use "Resend invite" once email is working.`);
  }

  req.setFlash({
    type: notEmailed.length || notAdded.length || invalid.length ? 'error' : 'success',
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

  const linked = await linkExistingEmployeeAccount(orgId, employee.email);
  const invite = await sendEmployeeInvite(employee.email);

  req.setFlash(
    invite.ok
      ? {
          type: 'success',
          message: linked
            ? `${employee.email} already had an account — activated now. Invite re-sent as well.`
            : `Invite re-sent to ${employee.email}.`,
        }
      : { type: 'error', message: `Could not send to ${employee.email} — check the mailer logs.` },
  );
  res.redirect('/hr/employees');
});

/**
 * Backfill for everyone already stuck as 'invited' with an existing
 * account. Without this, the only fix for those rows is to remove and
 * re-add the person, which loses their invite history.
 */
router.post('/employees/sync', async (req, res) => {
  const orgId = req.session.hrContact.orgId;

  const { data: pending } = await supabase
    .from('organization_employees')
    .select('email')
    .eq('org_id', orgId)
    .eq('status', 'invited')
    .is('user_id', null);

  let linked = 0;
  for (const row of pending || []) {
    if (await linkExistingEmployeeAccount(orgId, row.email)) linked += 1;
  }

  req.setFlash({
    type: linked ? 'success' : 'info',
    message: linked
      ? `${linked} employee(s) already had an account and are now active.`
      : 'No pending invites matched an existing account. Anyone still invited has not signed up yet.',
  });
  res.redirect('/hr/employees');
});

router.post('/employees/:employeeId/remove', async (req, res) => {
  const orgId = req.session.hrContact.orgId;
  const { employeeId } = req.params;

  const { data: removed, error } = await supabase
    .from('organization_employees')
    .update({ status: 'inactive', deactivated_at: new Date().toISOString() })
    .eq('id', employeeId)
    .eq('org_id', orgId)
    .select('email, user_id');

  if (error || !removed || !removed.length) {
    req.setFlash({ type: 'error', message: error ? 'Could not remove — ' + error.message : 'No such employee.' });
    return res.redirect('/hr/employees');
  }

  // Removing someone used to leave them on the organization's paid tier
  // indefinitely. Move them back to free — but only if the tier they're on
  // is the org's, so a personally paid plan is left alone.
  const userId = removed[0].user_id;
  if (userId) {
    const { data: org } = await supabase.from('organizations').select('subscription_tier_id').eq('id', orgId).maybeSingle();
    if (org && org.subscription_tier_id) {
      await supabase
        .from('client_profiles')
        .update({ subscription_tier: 'free' })
        .eq('user_id', userId)
        .eq('subscription_tier', org.subscription_tier_id);
    }
  }

  req.setFlash({ type: 'success', message: `${removed[0].email} removed. Their account stays; company-sponsored access ends now.` });
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

  // The employee must belong to this HR contact's own org — the id comes
  // from the form, which is not to be trusted.
  const { data: emp } = await supabase
    .from('organization_employees')
    .select('id')
    .eq('id', employee_id || '00000000-0000-0000-0000-000000000000')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!emp || !start_date || !end_date || new Date(end_date) < new Date(start_date)) {
    req.setFlash({ type: 'error', message: 'Pick one of your employees and a valid date range.' });
    return res.redirect('/hr/leave-requests');
  }

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
