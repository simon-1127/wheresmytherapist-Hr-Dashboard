const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { generateTempPassword } = require('../lib/passwords');
const { sendMail } = require('../config/mailer');

const router = express.Router();
router.use(requireSuperAdmin);

async function loadAdminRoles(roleType) {
  const { data: adminRoles } = await supabase
    .from('admin_roles')
    .select('user_id, role_type, granted_at, granted_by')
    .eq('role_type', roleType);

  if (!adminRoles || !adminRoles.length) return [];

  const { data: users } = await supabase
    .from('users')
    .select('id, email, phone, created_at')
    .in('id', adminRoles.map((r) => r.user_id));
  const usersById = {};
  (users || []).forEach((u) => (usersById[u.id] = u));
  return adminRoles.map((r) => ({ ...r, user: usersById[r.user_id] }));
}

router.get('/', async (req, res) => {
  const [admins, supportAgents] = await Promise.all([
    loadAdminRoles('super_admin'),
    loadAdminRoles('support_agent'),
  ]);
  res.render('settings/index', { admins, supportAgents, result: null });
});

// Support agents get a real Supabase Auth account (password-based, like
// super admins) plus an admin_roles row — this is what /support/login
// checks against.
router.post('/support-agents', async (req, res) => {
  const { email } = req.body;
  const tempPassword = generateTempPassword();

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not create support agent — ' + error.message });
    return res.redirect('/settings');
  }

  await supabase.from('admin_roles').insert({
    user_id: data.user.id,
    role_type: 'support_agent',
    granted_by: req.session.superAdmin.id,
  });

  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'support_agent.created',
    targetTable: 'admin_roles',
    targetId: data.user.id,
  });

  try {
    await sendMail({
      to: email,
      subject: "Support access — Where's My Therapist",
      html: `<p>Login email: <strong>${email}</strong><br/>Temporary password: <strong>${tempPassword}</strong></p>
        <p>Sign in at ${process.env.SUPPORT_DASHBOARD_URL}/support/login</p>`,
    });
  } catch (err) {
    console.error('[settings] support agent invite email failed:', err);
  }

  req.setFlash({
    type: 'success',
    message: `Support agent added. Temp password (shown once): ${tempPassword}`,
  });
  res.redirect('/settings');
});

module.exports = router;
