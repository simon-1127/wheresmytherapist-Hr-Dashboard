// Three separate auth systems live side by side in this app:
//
//  1. Super admin — a real Supabase Auth user with an admin_roles row,
//     role_type = 'super_admin'.
//
//  2. HR contact — NOT a Supabase Auth user. Credentials live in
//     organization_hr_contacts, scoped to exactly one org_id. Every HR
//     route must filter by req.session.hrContact.orgId — never trust an
//     org id coming from the request itself.
//
//  3. Support agent — like super admin, but role_type = 'support_agent',
//     scoped to /support. A super admin session also satisfies this.
//
// Sessions are signed cookies that can last 30 days ("remember me"). Before
// this change the role was checked once at login and then trusted for the
// cookie's whole life, so revoking a support agent or disabling an HR
// contact did nothing until their cookie expired. Each guard now re-checks
// the backing row at most every REVALIDATE_MS and ends the session if it's
// gone. A failed check (network blip) keeps the session rather than logging
// everyone out.

const { supabase } = require('../config/supabase');

const REVALIDATE_MS = 5 * 60 * 1000;

function due(sessionObj) {
  return !sessionObj.checkedAt || Date.now() - sessionObj.checkedAt > REVALIDATE_MS;
}

async function hasRole(userId, roleType) {
  const { data, error } = await supabase
    .from('admin_roles')
    .select('role_type')
    .eq('user_id', userId)
    .eq('role_type', roleType)
    .maybeSingle();
  if (error) return null; // unknown — don't punish the user for our outage
  return Boolean(data);
}

async function requireSuperAdmin(req, res, next) {
  const admin = req.session && req.session.superAdmin;
  if (!admin) return res.redirect('/login');

  if (due(admin)) {
    const ok = await hasRole(admin.id, 'super_admin');
    if (ok === false) {
      req.session = null;
      return res.redirect('/login');
    }
    if (ok) admin.checkedAt = Date.now();
  }
  res.locals.currentSuperAdmin = admin;
  next();
}

async function requireHrContact(req, res, next) {
  const hr = req.session && req.session.hrContact;
  if (!hr) return res.redirect('/hr/login');

  if (due(hr)) {
    const { data, error } = await supabase
      .from('organization_hr_contacts')
      .select('status, must_reset_password')
      .eq('id', hr.id)
      .maybeSingle();
    if (!error) {
      if (!data || data.status !== 'active') {
        req.session = null;
        return res.redirect('/hr/login');
      }
      hr.mustResetPassword = data.must_reset_password;
      hr.checkedAt = Date.now();
    }
  }

  // Reset lives in auth.routes.js (/hr/reset-password), outside this guard.
  if (hr.mustResetPassword) return res.redirect('/hr/reset-password');
  res.locals.currentHrContact = hr;
  next();
}

// Staff session = the /support/login session. It can belong to a
// support_agent or a finance member; older cookies have no roleType and
// are support agents.
function staffRoleOf(s) {
  return s && s.supportAgent ? s.supportAgent.roleType || 'support_agent' : null;
}

async function revalidateStaff(req) {
  const s = req.session || {};
  if (s.superAdmin && due(s.superAdmin)) {
    const ok = await hasRole(s.superAdmin.id, 'super_admin');
    if (ok === false) return false;
    if (ok) s.superAdmin.checkedAt = Date.now();
  }
  if (s.supportAgent && !s.superAdmin && due(s.supportAgent)) {
    const ok = await hasRole(s.supportAgent.id, staffRoleOf(s));
    if (ok === false) return false;
    if (ok) s.supportAgent.checkedAt = Date.now();
  }
  return true;
}

// Crisis/support console — support agents (and super admins) only.
async function requireSupportAccess(req, res, next) {
  const s = req.session || {};
  if (!s.superAdmin && !s.supportAgent) return res.redirect('/support/login');
  if (!(await revalidateStaff(req))) {
    req.session = null;
    return res.redirect('/support/login');
  }
  if (!s.superAdmin && staffRoleOf(s) !== 'support_agent') {
    // A finance login has no business in crisis alerts or client wellness
    // data; send them to the part of the portal that is theirs.
    return res.redirect('/sessions/refunds');
  }
  res.locals.currentSupportAgent = s.supportAgent || null;
  res.locals.staffRole = s.superAdmin ? 'super_admin' : staffRoleOf(s);
  next();
}

/**
 * Sessions & Refunds. Open to super admins (admin login) and to staff
 * (support/finance login). Sets req.viewer = { id, email, role } — the id
 * is what the backend receives as X-Admin-User-Id — and picks the layout
 * that matches how the person logged in.
 */
async function requireStaff(req, res, next) {
  const s = req.session || {};
  if (!s.superAdmin && !s.supportAgent) return res.redirect('/support/login');
  if (!(await revalidateStaff(req))) {
    req.session = null;
    return res.redirect('/support/login');
  }
  const role = s.superAdmin ? 'super_admin' : staffRoleOf(s);
  const who = s.superAdmin || s.supportAgent;
  req.viewer = { id: who.id, email: who.email, role };
  res.locals.viewer = req.viewer;
  res.locals.staffRole = role;
  if (s.superAdmin) {
    res.locals.currentSuperAdmin = s.superAdmin;
    res.locals.layout = 'partials/adminLayout';
  } else {
    res.locals.agent = s.supportAgent;
    res.locals.layout = 'partials/supportLayout';
  }
  next();
}

module.exports = { requireSuperAdmin, requireHrContact, requireSupportAccess, requireStaff };
