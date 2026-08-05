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
    { data: approvedGendocs },
    { data: activeAssignments },
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
    // Approved doctors nobody can actually reach yet. A doctor with no
    // active org assignment is invisible to every employee, which is easy
    // to create and impossible to spot from the doctors list alone.
    //
    // Two plain reads differenced in JS rather than a PostgREST anti-join
    // — the embedded-null filter form is fragile and silently returns the
    // wrong count when it doesn't match, which is worse than an extra
    // round trip on a page that already makes seven.
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
      unassignedGendocs,
    },
    orgs: orgs || [],
    employeeCounts,
    recentAudit: recentAudit || [],
  });
});

module.exports = router;
