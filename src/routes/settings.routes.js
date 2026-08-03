const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireSuperAdmin);

async function loadAdminRoles(roleTypes) {
  const { data: adminRoles } = await supabase
    .from('admin_roles')
    .select('user_id, role_type, full_name, granted_at, granted_by')
    .in('role_type', roleTypes);

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
  const [admins, teamMembers] = await Promise.all([
    loadAdminRoles(['super_admin']),
    loadAdminRoles(['support_agent', 'content_moderator', 'finance']),
  ]);
  res.render('settings/index', { admins, teamMembers });
});

module.exports = router;
