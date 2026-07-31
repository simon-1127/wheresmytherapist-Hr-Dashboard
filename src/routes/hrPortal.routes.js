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
  for (const email of list) {
    const { error } = await supabase.from('organization_employees').insert({
      org_id: orgId,
      email,
      added_by_hr_contact_id: req.session.hrContact.id,
    });
    if (!error) {
      added += 1;

      // Kick off a Supabase magic link — this creates the auth.users (and,
      // via the existing trigger, public.users) row if it doesn't exist yet,
      // and lands the employee in the CONSUMER app, not this dashboard.
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
            html: `<p>Your employer has set you up with access to Where's My Therapist.</p>
              <p><a href="${linkData.properties.action_link}">Click here to get started</a></p>`,
          });
        }
      } catch (err) {
        console.error('[hr-portal] magic link generation failed for', email, err);
      }
    }
  }

  req.setFlash({ type: 'success', message: `${added} of ${list.length} employee(s) added.` });
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
