const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { REVIEW_STATUSES } = require('../lib/providers');

const router = express.Router();

const DAY = 24 * 60 * 60 * 1000;

router.get('/', requireSuperAdmin, async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();

  const [
    { count: totalOrgs },
    { count: totalEmployees },
    { count: activeEmployees },
    { count: pendingProviders },
    { count: openAlerts },
    { data: providerUsers },
    { data: profileIds },
    { count: staleInvites },
    { count: hrNeverLoggedIn },
    { data: approvedGendocs },
    { data: activeAssignments },
    { data: orgs },
    { data: recentAudit },
  ] = await Promise.all([
    supabase.from('organizations').select('id', { count: 'exact', head: true }),
    supabase.from('organization_employees').select('id', { count: 'exact', head: true }),
    supabase.from('organization_employees').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase
      .from('provider_profiles')
      .select('user_id', { count: 'exact', head: true })
      .in('application_status', REVIEW_STATUSES),
    supabase.from('crisis_alerts').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    // Provider signups with no profile = provider-role users minus profile ids.
    supabase.from('users').select('id').eq('role', 'provider').neq('status', 'deleted'),
    supabase.from('provider_profiles').select('user_id'),
    supabase
      .from('organization_employees')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'invited')
      .lt('invited_at', weekAgo),
    supabase
      .from('organization_hr_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .is('last_login_at', null),
    // Approved doctors nobody can actually reach yet — two plain reads
    // differenced in JS rather than a fragile PostgREST anti-join.
    supabase.from('gendoc_profiles').select('user_id').eq('application_status', 'approved'),
    supabase.from('gendoc_org_assignments').select('gendoc_id').eq('is_active', true),
    supabase
      .from('organizations')
      .select('id, company_name, spoc_name, status, created_at')
      .order('created_at', { ascending: false })
      .limit(6),
    supabase
      .from('admin_audit_log')
      .select('id, action, target_table, created_at, details')
      .order('created_at', { ascending: false })
      .limit(6),
  ]);

  const assignedGendocIds = new Set((activeAssignments || []).map((a) => a.gendoc_id));
  const unassignedGendocs = (approvedGendocs || []).filter((g) => !assignedGendocIds.has(g.user_id)).length;

  const withProfile = new Set((profileIds || []).map((p) => p.user_id));
  const providersNoProfile = (providerUsers || []).filter((u) => !withProfile.has(u.id)).length;

  const employeeCounts = {};
  if (orgs && orgs.length) {
    const { data: counts } = await supabase
      .from('organization_employees')
      .select('org_id')
      .in('org_id', orgs.map((o) => o.id));
    (counts || []).forEach((row) => {
      employeeCounts[row.org_id] = (employeeCounts[row.org_id] || 0) + 1;
    });
  }

  // Ordered by urgency. Only non-zero items render.
  const attention = [
    { n: openAlerts || 0, label: 'new crisis alert(s) not yet acknowledged', href: '/support/alerts', urgent: true },
    { n: pendingProviders || 0, label: 'provider profile(s) waiting for review', href: '/providers?tab=review' },
    { n: providersNoProfile, label: 'provider signup(s) with no profile yet', href: '/providers?tab=incomplete' },
    { n: unassignedGendocs, label: 'approved doctor(s) not assigned to any organization', href: '/gendocs' },
    { n: staleInvites || 0, label: 'employee invite(s) unanswered for 7+ days', href: '/users?segment=org_employees' },
    { n: hrNeverLoggedIn || 0, label: 'HR contact(s) who have never logged in', href: '/organizations' },
  ].filter((a) => a.n > 0);

  res.render('dashboard/index', {
    stats: {
      totalOrgs: totalOrgs || 0,
      totalEmployees: totalEmployees || 0,
      activeEmployees: activeEmployees || 0,
      openAlerts: openAlerts || 0,
      pendingProviders: pendingProviders || 0,
      unassignedGendocs,
    },
    attention,
    orgs: orgs || [],
    employeeCounts,
    recentAudit: recentAudit || [],
  });
});

module.exports = router;
