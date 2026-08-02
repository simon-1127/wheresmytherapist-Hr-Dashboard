// Two completely separate auth systems live side by side in this app:
//
//  1. Super admin — a real Supabase Auth user (public.users.role handling is
//     irrelevant here; what matters is an admin_roles row with
//     role_type = 'super_admin'). Verified once at login; the signed,
//     httpOnly session cookie is trusted after that.
//
//  2. HR contact — NOT a Supabase Auth user at all. Credentials live in
//     organization_hr_contacts, scoped to exactly one org_id. Every HR
//     route must filter by req.session.hrContact.orgId — never trust a
//     org id coming from the request itself.

function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.superAdmin) {
    return res.redirect('/login');
  }
  res.locals.currentSuperAdmin = req.session.superAdmin;
  next();
}

function requireHrContact(req, res, next) {
  if (!req.session || !req.session.hrContact) {
    return res.redirect('/hr/login');
  }
  if (req.session.hrContact.mustResetPassword && !req.path.startsWith('/hr/reset-password')) {
    return res.redirect('/hr/reset-password');
  }
  res.locals.currentHrContact = req.session.hrContact;
  next();
}

// 3. Support agent — same shape as super admin (real Supabase Auth user,
//    admin_roles row, role_type = 'support_agent'), but scoped to only the
//    crisis-review pages reached via a crisis alert email link. A super
//    admin session also satisfies this, since super admins can see
//    everything a support agent can.
function requireSupportAccess(req, res, next) {
  if (!req.session || (!req.session.superAdmin && !req.session.supportAgent)) {
    return res.redirect('/support/login');
  }
  res.locals.currentSupportAgent = req.session.supportAgent || null;
  next();
}

module.exports = { requireSuperAdmin, requireHrContact, requireSupportAccess };
