const express = require('express');
const { supabase } = require('../config/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { logAction } = require('../lib/audit');

const router = express.Router();
router.use(requireSuperAdmin);

router.get('/', async (req, res) => {
  const filter = req.query.status || 'pending_review';

  let q = supabase
    .from('provider_profiles')
    .select(
      'user_id, full_name, professional_title, years_experience, application_status, kyc_status, license_no, created_at',
    )
    .order('created_at', { ascending: false });

  if (filter === 'pending_review') {
    q = q.in('application_status', ['submitted', 'under_review']);
  } else if (filter !== 'all') {
    q = q.eq('application_status', filter);
  }

  const { data: providers } = await q;
  res.render('providers/index', { providers: providers || [], filter });
});

router.post('/:userId/decision', async (req, res) => {
  const { userId } = req.params;
  const { decision, rejection_reason } = req.body;

  const update = {
    application_status: decision,
    rejection_reason: decision === 'rejected' ? rejection_reason || null : null,
  };
  if (decision === 'approved') update.approved_at = new Date().toISOString();

  await supabase.from('provider_profiles').update(update).eq('user_id', userId);

  await supabase.from('provider_application_reviews').insert({
    provider_id: userId,
    submitted_at: new Date().toISOString(),
    reviewed_by: req.session.superAdmin.id,
    decision,
    decision_reason: rejection_reason || null,
    reviewed_at: new Date().toISOString(),
  });

  await logAction({
    adminId: req.session.superAdmin.id,
    action: `provider.application.${decision}`,
    targetTable: 'provider_profiles',
    targetId: userId,
  });

  res.redirect('/providers');
});

module.exports = router;
