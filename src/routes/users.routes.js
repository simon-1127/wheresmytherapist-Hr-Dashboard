const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');
const { uuidParams, sanitizeSearch } = require('../lib/validate');
const { delistIfListed } = require('../lib/providers');
const gendocs = require('../lib/gendocs');
const { searchSessions } = require('../lib/sessionQueries');
const { inr, SESSION_STATUS, FAULT_LABEL, SETTLEMENT_LABEL } = require('../lib/sessionPolicy');

const router = express.Router();
router.use(requireSuperAdmin);
uuidParams(router, ['id'], '/users', 'Back to users');

const SEGMENTS = ['clients', 'org_employees', 'providers', 'staff'];
const STATUSES = ['active', 'suspended', 'deleted'];

// Segmented, not one giant list — "keep org employees in a separate list,
// no mix-up with real clients".
router.get('/', async (req, res) => {
  let segment = req.query.segment || 'clients';
  if (segment === 'admins') segment = 'staff'; // old tab name
  if (!SEGMENTS.includes(segment)) segment = 'clients';
  const search = sanitizeSearch(req.query.search);

  let rows = [];

  if (segment === 'org_employees') {
    let q = supabase
      .from('organization_employees')
      .select('id, email, status, invited_at, joined_at, user_id, org_id, organizations(company_name)')
      .order('invited_at', { ascending: false });
    if (search) q = q.ilike('email', `%${search}%`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not load employees — ${error.message}`);
    rows = data || [];
  } else if (segment === 'staff') {
    // Staff are identified by admin_roles, not users.role. The old "Admins"
    // tab filtered users.role = 'admin', which no account has, so it was
    // always empty.
    const { data: roles, error } = await supabase.from('admin_roles').select('user_id, role_type, full_name');
    if (error) throw new Error(`Could not load staff — ${error.message}`);
    const ids = (roles || []).map((r) => r.user_id);
    if (ids.length) {
      let q = supabase.from('users').select('id, role, email, phone, status, created_at').in('id', ids);
      if (search) q = q.or(`email.ilike.%${search}%,phone.ilike.%${search}%`);
      const { data } = await q;
      const roleOf = Object.fromEntries((roles || []).map((r) => [r.user_id, r]));
      rows = (data || []).map((u) => ({ ...u, staffRole: roleOf[u.id] }));
    }
  } else {
    const roleFilter = segment === 'providers' ? 'provider' : 'client';
    let q = supabase
      .from('users')
      .select('id, role, email, phone, status, created_at')
      .eq('role', roleFilter)
      .order('created_at', { ascending: false });
    if (search) q = q.or(`email.ilike.%${search}%,phone.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) throw new Error(`Could not load users — ${error.message}`);
    rows = data || [];

    if (roleFilter === 'client') {
      // Individual clients only: not org employees, not WMT staff.
      const [{ data: links }, { data: staff }] = await Promise.all([
        supabase.from('organization_employees').select('user_id').not('user_id', 'is', null),
        supabase.from('admin_roles').select('user_id'),
      ]);
      const exclude = new Set([...(links || []), ...(staff || [])].map((r) => r.user_id));
      rows = rows.filter((u) => !exclude.has(u.id));
    }
  }

  res.render('users/index', { rows, segment, search });
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: user } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (!user) return res.status(404).render('errors/404', { layout: false, backHref: '/users', backLabel: 'Back to users' });

  const [
    { data: clientProfile },
    { data: providerProfile },
    { data: staffRole },
    { data: orgLink },
    { data: crisisAlerts },
    { data: payments },
    { data: sessionHistory },
    { data: tiers },
  ] = await Promise.all([
    supabase.from('client_profiles').select('*').eq('user_id', id).maybeSingle(),
    supabase.from('provider_profiles').select('user_id, full_name, professional_title, application_status, kyc_status').eq('user_id', id).maybeSingle(),
    supabase.from('admin_roles').select('role_type, full_name').eq('user_id', id).maybeSingle(),
    supabase
      .from('organization_employees')
      .select('org_id, status, organizations(company_name, subscription_tier_id)')
      .eq('user_id', id)
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('crisis_alerts')
      .select('id, severity, status, trigger_type, created_at, resolved_at')
      .eq('user_id', id)
      .order('created_at', { ascending: false }),
    // payments has no user_id column — it links via sessions.client_id.
    supabase
      .from('payments')
      .select('id, amount, status, method, created_at, sessions!inner(client_id, currency)')
      .eq('sessions.client_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('sessions')
      .select('id, provider_id, scheduled_start, status')
      .eq('client_id', id)
      .order('scheduled_start', { ascending: false }),
    supabase.from('subscription_tiers').select('id, display_name').order('sort_order'),
  ]);

  const tab = req.query.tab === 'sessions' ? 'sessions' : 'overview';
  let sessions = [];
  let sessionsError = null;
  if (tab === 'sessions') {
    // As client AND as provider — evidence lives on the Sessions pages.
    sessions = await searchSessions({ userId: id, limit: 200 }).catch((err) => {
      sessionsError = err.message;
      return [];
    });
  }

  res.render('users/show', {
    tab,
    sessions,
    sessionsError,
    inr,
    SESSION_STATUS,
    FAULT_LABEL,
    SETTLEMENT_LABEL,
    user,
    // `profile` kept for the existing template; client data wins for clients.
    profile: user.role === 'provider' ? providerProfile : clientProfile,
    clientProfile,
    providerProfile,
    staffRole,
    orgLink,
    tiers: tiers || [],
    crisisAlerts: crisisAlerts || [],
    payments: payments || [],
    sessionHistory: sessionHistory || [],
  });
});

router.post('/:id/tier', async (req, res) => {
  const { id } = req.params;
  const { subscription_tier: tier } = req.body;

  const { data: valid } = await supabase.from('subscription_tiers').select('id').eq('id', tier).maybeSingle();
  if (!valid) {
    req.setFlash({ type: 'error', message: 'Unknown tier.' });
    return res.redirect(`/users/${id}`);
  }

  // A DB trigger (fn_enforce_language_tier) can reject this if the user's
  // preferred_language isn't allowed on the new tier — surfaced as a flash.
  const { data: updated, error } = await supabase
    .from('client_profiles')
    .update({ subscription_tier: tier })
    .eq('user_id', id)
    .select('user_id');
  if (error || !updated || !updated.length) {
    req.setFlash({
      type: 'error',
      message: error ? 'Could not change tier — ' + error.message : 'This account has no client profile yet, so it has no tier to change.',
    });
    return res.redirect(`/users/${id}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `user.tier.${tier}`,
    targetTable: 'client_profiles',
    targetId: id,
  });

  req.setFlash({ type: 'success', message: `Tier changed to ${tier}.` });
  res.redirect(`/users/${id}`);
});

router.post('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!STATUSES.includes(status)) {
    req.setFlash({ type: 'error', message: 'Unknown status.' });
    return res.redirect(`/users/${id}`);
  }
  if (id === req.session.superAdmin.id) {
    req.setFlash({ type: 'error', message: "You can't change the status of your own account." });
    return res.redirect(`/users/${id}`);
  }

  const update = { status, deleted_at: status === 'deleted' ? new Date().toISOString() : null };
  const { error } = await supabase.from('users').update(update).eq('id', id);
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not update status — ' + error.message });
    return res.redirect(`/users/${id}`);
  }

  const notes = [];
  if (status !== 'active') {
    // Approved providers stay bookable otherwise — listing only looks at
    // provider_profiles.application_status.
    if (await delistIfListed(supabase, id, `Account ${status} by admin`)) {
      notes.push('Their provider listing was hidden — reinstate it from Providers if this is undone.');
    }
    if (await gendocs.delistIfListed(supabase, id, `Account ${status} by admin`)) {
      notes.push("They were hidden as a general doctor and today's queue was cancelled — reinstate from General doctors if this is undone.");
    }
    // Staff lose dashboard access with their account.
    const { data: revoked } = await supabase
      .from('admin_roles')
      .delete()
      .eq('user_id', id)
      .neq('role_type', 'super_admin')
      .select('user_id');
    if (revoked && revoked.length) notes.push('Their support-team access was revoked.');
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `user.status.${status}`,
    targetTable: 'users',
    targetId: id,
    details: notes.length ? { side_effects: notes } : {},
  });

  req.setFlash({ type: 'success', message: [`Account ${status === 'active' ? 'reactivated' : status}.`, ...notes].join(' ') });
  res.redirect(`/users/${id}`);
});

module.exports = router;
