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
    // TEMPORARY until real Razorpay/RazorpayX KYC verification exists
    // (currently just a stub — see provider_kyc_stub_screen.dart): the
    // client-facing RLS policy providers actually need to appear through
    // (provider_profiles_select_public) gates on is_publicly_listed, which
    // is a GENERATED column — `GENERATED ALWAYS AS (application_status =
    // 'approved' AND kyc_status = 'verified') STORED`. It can't be written
    // directly (an earlier version of this code tried, which made Postgres
    // reject the WHOLE update statement — approving silently did nothing
    // at all, since the error from this call was never checked either).
    // It also means approving alone was never enough to list anyone: with
    // no real KYC flow setting kyc_status, that half of the formula never
    // becomes 'verified' on its own. This line bypasses that until the
    // real flow exists — remove it once KYC verification is actually
    // built, since this currently lists a provider without any real
    // verification happening.
    kyc_status: decision === 'approved' ? 'verified' : undefined,
  };
  if (decision === 'approved') update.approved_at = new Date().toISOString();

  const { error: updateError } = await supabase.from('provider_profiles').update(update).eq('user_id', userId);
  if (updateError) {
    req.setFlash({ type: 'error', message: 'Could not update provider — ' + updateError.message });
    return res.redirect('/providers');
  }

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