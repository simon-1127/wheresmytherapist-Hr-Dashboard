const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { sendMail } = require('../config/mailer');
const { uuidParams, normalizeEmail, isEmail, escapeHtml, dashboardUrl } = require('../lib/validate');

// WMT's own staff. (This used to be the "Onboarding" tab, which also
// created providers and upgraded clients into providers. Providers now sign
// up on the website and are only approved, under /providers.)
//
// support_agent -> the /support console (crisis, wellness) + Sessions view
//                  and outcome changes.
// finance       -> Sessions & Refunds only (refunds, settlements).
// Both sign in at /support/login. content_moderator still has no portal and
// isn't offered.
const ASSIGNABLE_ROLES = ['support_agent', 'finance'];
const ROLE_LABEL = { support_agent: 'support agent', finance: 'finance' };
const STAFF_ROLES = ['support_agent', 'content_moderator', 'finance'];

const router = express.Router();
router.use(requireSuperAdmin);
uuidParams(router, ['userId'], '/team', 'Back to team');

async function loadStaff() {
  const { data: roles, error } = await supabase
    .from('admin_roles')
    .select('user_id, role_type, full_name, granted_at, granted_by')
    .order('granted_at', { ascending: true });
  if (error) throw new Error(`Could not load team — ${error.message}`);
  if (!roles || !roles.length) return { admins: [], staff: [] };

  const { data: users } = await supabase
    .from('users')
    .select('id, email, phone, status')
    .in('id', roles.map((r) => r.user_id));
  const byId = Object.fromEntries((users || []).map((u) => [u.id, u]));
  const rows = roles.map((r) => ({ ...r, user: byId[r.user_id] || null }));
  return {
    admins: rows.filter((r) => r.role_type === 'super_admin'),
    staff: rows.filter((r) => r.role_type !== 'super_admin'),
  };
}

router.get('/', async (req, res) => {
  const { admins, staff } = await loadStaff();
  res.render('team/index', { title: 'Team', admins, staff, meId: req.session.superAdmin.id });
});

router.post('/members', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const fullName = (req.body.full_name || '').trim();
  const password = req.body.password || '';
  const roleType = req.body.role_type || 'support_agent';

  if (!ASSIGNABLE_ROLES.includes(roleType)) {
    req.setFlash({ type: 'error', message: 'Not a valid role for this form.' });
    return res.redirect('/team');
  }
  if (!isEmail(email) || !fullName) {
    req.setFlash({ type: 'error', message: 'A valid email and a name are both required.' });
    return res.redirect('/team');
  }

  // Existing account? (e.g. support@ was once used to sign up in the app.)
  // Grant the role to it instead of failing on "already registered".
  const { data: existing } = await supabase.from('users').select('id, role').eq('email', email).maybeSingle();

  let userId;
  let reusedAccount = false;
  if (existing) {
    const { data: role } = await supabase.from('admin_roles').select('role_type').eq('user_id', existing.id).maybeSingle();
    if (role) {
      req.setFlash({ type: 'error', message: `${email} already has the ${role.role_type.replace('_', ' ')} role.` });
      return res.redirect('/team');
    }
    if (existing.role === 'provider' || existing.role === 'gendoc') {
      req.setFlash({ type: 'error', message: `${email} is a ${existing.role} account. Use a different email for staff access.` });
      return res.redirect('/team');
    }
    // public.users can outlive its auth.users row (an auth user deleted
    // from the Supabase dashboard leaves the public row behind). Granting a
    // role to that would produce a login that can never work.
    const { data: authUser, error: authErr } = await supabase.auth.admin.getUserById(existing.id);
    if (authErr || !authUser || !authUser.user) {
      req.setFlash({
        type: 'error',
        message: `${email} has an app record but no login (its Supabase auth user was deleted). See System → "Accounts without a login" to clean it up, then add them again.`,
      });
      return res.redirect('/team');
    }
    userId = existing.id;
    reusedAccount = true;
    if (password) {
      if (password.length < 8) {
        req.setFlash({ type: 'error', message: 'Password must be at least 8 characters.' });
        return res.redirect('/team');
      }
      const { error: pwErr } = await supabase.auth.admin.updateUserById(userId, { password });
      if (pwErr) {
        req.setFlash({ type: 'error', message: 'Could not set password on the existing account — ' + pwErr.message });
        return res.redirect('/team');
      }
    }
  } else {
    if (password.length < 8) {
      req.setFlash({ type: 'error', message: 'Password must be at least 8 characters.' });
      return res.redirect('/team');
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) {
      console.error('[team] createUser failed:', error);
      req.setFlash({ type: 'error', message: 'Could not create account — ' + (error.message || 'see server logs') });
      return res.redirect('/team');
    }
    userId = data.user.id;
    // admin_roles.user_id has an FK to public.users. Don't rely on the auth
    // trigger alone having created that row (it's the same gap the HR
    // portal's invite path hit).
    await supabase
      .from('users')
      .upsert({ id: userId, email, role: 'client' }, { onConflict: 'id', ignoreDuplicates: true });
  }

  const { error: roleErr } = await supabase.from('admin_roles').insert({
    user_id: userId,
    role_type: roleType,
    full_name: fullName,
    granted_by: req.session.superAdmin.id,
  });
  if (roleErr) {
    req.setFlash({ type: 'error', message: 'Account ready but role assignment failed — ' + roleErr.message });
    return res.redirect('/team');
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `team_member.created.${roleType}`,
    targetTable: 'admin_roles',
    targetId: userId,
    details: { email, reused_existing_account: reusedAccount },
  });

  await sendMail({
    to: email,
    subject: "Team access — Where's My Therapist",
    html: `<p>Hi ${escapeHtml(fullName)},</p>
      <p>You now have ${ROLE_LABEL[roleType]} access to the Where's My Therapist team portal.</p>
      <p>Login email: <strong>${escapeHtml(email)}</strong><br/>
      Sign in at <a href="${dashboardUrl()}/support/login">${dashboardUrl()}/support/login</a>.
      ${reusedAccount && !password ? 'Use the password you already have for this email.' : 'Your admin will share your password with you directly.'}</p>`,
  });

  req.setFlash({
    type: 'success',
    message: reusedAccount
      ? `${email} already had an account — ${ROLE_LABEL[roleType]} access granted.${password ? ' Password updated.' : ' They keep their existing password.'}`
      : `${fullName} added as ${ROLE_LABEL[roleType]}.`,
  });
  res.redirect('/team');
});

router.post('/:userId/revoke', async (req, res) => {
  const { userId } = req.params;
  if (userId === req.session.superAdmin.id) {
    req.setFlash({ type: 'error', message: "You can't revoke your own access." });
    return res.redirect('/team');
  }
  const { data: removed, error } = await supabase
    .from('admin_roles')
    .delete()
    .eq('user_id', userId)
    .in('role_type', STAFF_ROLES) // super_admin is managed in the DB only
    .select('user_id, role_type');
  if (error || !removed || !removed.length) {
    req.setFlash({ type: 'error', message: error ? error.message : 'Nothing to revoke (super admins are managed in the database).' });
    return res.redirect('/team');
  }
  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'team_member.revoked',
    targetTable: 'admin_roles',
    targetId: userId,
    details: { role_type: removed[0].role_type },
  });
  req.setFlash({ type: 'success', message: 'Access revoked. Any open session ends within 5 minutes.' });
  res.redirect('/team');
});

router.post('/:userId/password', async (req, res) => {
  const { userId } = req.params;
  const password = req.body.password || '';
  if (password.length < 8) {
    req.setFlash({ type: 'error', message: 'Password must be at least 8 characters.' });
    return res.redirect('/team');
  }
  const { data: role } = await supabase.from('admin_roles').select('role_type').eq('user_id', userId).maybeSingle();
  if (!role || role.role_type === 'super_admin') {
    req.setFlash({ type: 'error', message: 'Only team (support/finance) passwords can be reset here.' });
    return res.redirect('/team');
  }
  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not reset password — ' + error.message });
    return res.redirect('/team');
  }
  await logAction({
    adminId: req.session.superAdmin.id,
    action: 'team_member.password_reset',
    targetTable: 'admin_roles',
    targetId: userId,
  });
  req.setFlash({ type: 'success', message: 'Password updated. Share it with them directly.' });
  res.redirect('/team');
});

module.exports = router;
