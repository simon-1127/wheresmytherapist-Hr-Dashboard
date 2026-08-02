const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');

const router = express.Router();
router.use(requireSuperAdmin);

// Segmented, not one giant list — this is the "keep org employees in a
// separate list, no mix-up with real clients" requirement.
router.get('/', async (req, res) => {
  const segment = req.query.segment || 'clients';
  const search = (req.query.search || '').trim();

  // Every org-linked user_id, so the "clients" segment can exclude them.
  const { data: orgEmployeeLinks } = await supabase
    .from('organization_employees')
    .select('user_id')
    .not('user_id', 'is', null);
  const orgUserIds = (orgEmployeeLinks || []).map((r) => r.user_id);

  let rows = [];

  if (segment === 'org_employees') {
    let q = supabase
      .from('organization_employees')
      .select('id, email, status, invited_at, joined_at, user_id, org_id, organizations(company_name)')
      .order('invited_at', { ascending: false });
    if (search) q = q.ilike('email', `%${search}%`);
    const { data } = await q;
    rows = data || [];
  } else {
    let roleFilter = segment === 'providers' ? 'provider' : segment === 'admins' ? 'admin' : 'client';
    let q = supabase
      .from('users')
      .select('id, role, email, phone, status, created_at')
      .eq('role', roleFilter)
      .order('created_at', { ascending: false });
    if (search) q = q.or(`email.ilike.%${search}%,phone.ilike.%${search}%`);
    const { data } = await q;
    rows = (data || []).filter((u) => (roleFilter === 'client' ? !orgUserIds.includes(u.id) : true));
  }

  res.render('users/index', { rows, segment, search });
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const { data: user } = await supabase.from('users').select('*').eq('id', id).single();
  if (!user) return res.status(404).render('errors/404', { layout: false });

  let profile = null;
  if (user.role === 'client') {
    const { data } = await supabase.from('client_profiles').select('*').eq('user_id', id).maybeSingle();
    profile = data;
  } else if (user.role === 'provider') {
    const { data } = await supabase.from('provider_profiles').select('*').eq('user_id', id).maybeSingle();
    profile = data;
  }

  const { data: orgLink } = await supabase
    .from('organization_employees')
    .select('org_id, status, organizations(company_name)')
    .eq('user_id', id)
    .maybeSingle();

  const { data: crisisAlerts } = await supabase
    .from('crisis_alerts')
    .select('id, severity, status, trigger_type, created_at, resolved_at')
    .eq('user_id', id)
    .order('created_at', { ascending: false });

  // payments has no user_id column — it links to the user via
  // sessions.client_id, so filter through an inner join on that.
  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount, status, method, created_at, sessions!inner(client_id, currency)')
    .eq('sessions.client_id', id)
    .order('created_at', { ascending: false });

  const { data: sessionHistory } = await supabase
    .from('sessions')
    .select('id, provider_id, scheduled_start, status')
    .eq('client_id', id)
    .order('scheduled_start', { ascending: false });

  res.render('users/show', {
    user,
    profile,
    orgLink,
    crisisAlerts: crisisAlerts || [],
    payments: payments || [],
    sessionHistory: sessionHistory || [],
  });
});

router.post('/:id/tier', async (req, res) => {
  const { id } = req.params;
  const { subscription_tier } = req.body;

  // A DB trigger (fn_enforce_language_tier) can reject this if the user's
  // preferred_language isn't in the new tier's allowed_language_codes —
  // surface that as a flash message instead of a 500.
  const { error } = await supabase.from('client_profiles').update({ subscription_tier }).eq('user_id', id);
  if (error) {
    req.setFlash({ type: 'error', message: 'Could not change tier — ' + error.message });
    return res.redirect(`/users/${id}`);
  }

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `user.tier.${subscription_tier}`,
    targetTable: 'client_profiles',
    targetId: id,
  });

  res.redirect(`/users/${id}`);
});

router.post('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const update = { status };
  if (status === 'deleted') update.deleted_at = new Date().toISOString();

  await supabase.from('users').update(update).eq('id', id);

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `user.status.${status}`,
    targetTable: 'users',
    targetId: id,
  });

  res.redirect(`/users/${id}`);
});

module.exports = router;
