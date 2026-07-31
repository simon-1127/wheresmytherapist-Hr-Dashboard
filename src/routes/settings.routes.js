const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireSuperAdmin);

router.get('/', async (req, res) => {
  const { data: adminRoles } = await supabase
    .from('admin_roles')
    .select('user_id, role_type, granted_at, granted_by')
    .eq('role_type', 'super_admin');

  let admins = [];
  if (adminRoles && adminRoles.length) {
    const { data: users } = await supabase
      .from('users')
      .select('id, email, phone, created_at')
      .in(
        'id',
        adminRoles.map((r) => r.user_id),
      );
    const usersById = {};
    (users || []).forEach((u) => (usersById[u.id] = u));
    admins = adminRoles.map((r) => ({ ...r, user: usersById[r.user_id] }));
  }

  res.render('settings/index', { admins });
});

module.exports = router;
