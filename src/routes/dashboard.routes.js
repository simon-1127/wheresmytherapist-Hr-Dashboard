const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireSuperAdmin, async (req, res) => {
  const [
    { count: totalOrgs },
    { count: totalEmployees },
    { count: activeEmployees },
    { count: pendingLeave },
    { count: pendingKyc },
    { data: orgs },
    { data: recentAudit },
  ] = await Promise.all([
    supabase.from('organizations').select('id', { count: 'exact', head: true }),
    supabase.from('organization_employees').select('id', { count: 'exact', head: true }),
    supabase
      .from('organization_employees')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase
      .from('organization_leave_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending'),
    supabase
      .from('provider_profiles')
      .select('user_id', { count: 'exact', head: true })
      .in('application_status', ['submitted', 'under_review']),
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

  // Employee counts per org, for the table below
  let employeeCounts = {};
  if (orgs && orgs.length) {
    const { data: counts } = await supabase
      .from('organization_employees')
      .select('org_id')
      .in(
        'org_id',
        orgs.map((o) => o.id),
      );
    (counts || []).forEach((row) => {
      employeeCounts[row.org_id] = (employeeCounts[row.org_id] || 0) + 1;
    });
  }

  res.render('dashboard/index', {
    stats: {
      totalOrgs: totalOrgs || 0,
      totalEmployees: totalEmployees || 0,
      activeEmployees: activeEmployees || 0,
      pendingLeave: pendingLeave || 0,
      pendingKyc: pendingKyc || 0,
    },
    orgs: orgs || [],
    employeeCounts,
    recentAudit: recentAudit || [],
  });
});

module.exports = router;
