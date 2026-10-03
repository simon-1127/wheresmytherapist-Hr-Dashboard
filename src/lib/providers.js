// Provider review — the whole pipeline is now:
//
//   website signup (any email)  ->  users.role = 'provider' + provider_profiles row
//   ->  shows up under Providers > Needs review  ->  Approve / Reject
//
// Nothing is created from this dashboard any more. The old "create a
// provider account" and "upgrade a client to provider" flows are gone.
//
// Listing on the app is controlled by ONE column: provider_profiles
// .is_publicly_listed is GENERATED as (application_status = 'approved').
// KYC is not part of it, so approving never touches kyc_status — the old
// code force-set kyc_status = 'verified' on approval, which marked
// providers as payout-verified when nobody had verified anything.

const { sendMail } = require('../config/mailer');
const { escapeHtml } = require('./validate');

// Everything a provider can be sitting in before a decision. 'draft' is
// included on purpose: the provider-side update trigger blocks a provider
// from changing their own application_status, so depending on how the
// website writes the row it may never leave 'draft' on its own. Showing
// drafts in the queue (with a readiness checklist) means nobody can get
// stuck invisible.
const REVIEW_STATUSES = ['draft', 'submitted', 'under_review'];

// Which decision is allowed from which status. Anything else is refused
// server-side, whatever the form posted.
const TRANSITIONS = {
  approve: ['draft', 'submitted', 'under_review', 'rejected', 'suspended'],
  reject: ['draft', 'submitted', 'under_review'],
  suspend: ['approved'],
};

const DECISION_TO_STATUS = { approve: 'approved', reject: 'rejected', suspend: 'suspended' };

const PLACEHOLDER_TITLE = 'Not yet provided';

/**
 * What a reviewer should eyeball before approving. Nothing here blocks an
 * approval — it's a checklist, not a gate — but a profile with gaps asks for
 * an explicit confirm in the UI.
 */
function readiness(profile, extras = {}) {
  if (!profile) return { items: [], missing: 0, ready: false };
  const items = [
    { label: 'Full name', ok: Boolean(profile.full_name && profile.full_name.trim().length > 1) },
    {
      label: 'Professional title',
      ok: Boolean(profile.professional_title && profile.professional_title !== PLACEHOLDER_TITLE),
    },
    { label: 'License / registration no.', ok: Boolean(profile.license_no && profile.license_no.trim()) },
    { label: 'Qualifications', ok: Array.isArray(profile.education_credentials) && profile.education_credentials.length > 0 },
    { label: 'Bio', ok: Boolean(profile.bio && profile.bio.trim().length >= 20) },
    { label: 'Photo', ok: Boolean(profile.photo_url) },
    // base_session_rate is in paise; 1 was the old dashboard placeholder.
    { label: 'Session rate', ok: Number(profile.base_session_rate) > 100 },
    { label: 'Profile completed by provider', ok: profile.profile_completed_by_provider !== false },
  ];
  if (extras.specialties !== undefined) items.push({ label: 'At least one specialty', ok: extras.specialties > 0 });
  if (extras.languages !== undefined) items.push({ label: 'At least one language', ok: extras.languages > 0 });
  const missing = items.filter((i) => !i.ok).length;
  return { items, missing, ready: missing === 0 };
}

function rupees(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '—';
  return `₹${(n / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

const NOTIFY_COPY = {
  approve: {
    title: 'Profile approved',
    body: 'Your profile is approved and now visible to clients.',
    subject: "You're approved — Where's My Therapist",
    html: (name) => `<p>Hi ${escapeHtml(name)},</p>
      <p>Your provider profile on Where's My Therapist has been approved and is now visible to clients.</p>
      <p>Open the app to set your availability so clients can book you. To receive payouts, complete the payout (KYC) step in the app if you haven't already.</p>`,
  },
  reject: {
    title: 'Application update',
    body: 'Your provider application was not approved.',
    subject: "Your application — Where's My Therapist",
    html: (name, reason) => `<p>Hi ${escapeHtml(name)},</p>
      <p>Thank you for applying to Where's My Therapist. We're unable to approve your provider profile at this time.</p>
      ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
      <p>If you can address this, update your profile in the app and reply to this email — we'll take another look.</p>`,
  },
  suspend: {
    title: 'Profile paused',
    body: 'Your profile is temporarily hidden from clients. Contact support for details.',
    subject: "Your profile is paused — Where's My Therapist",
    html: (name, reason) => `<p>Hi ${escapeHtml(name)},</p>
      <p>Your provider profile has been temporarily hidden from clients.</p>
      ${reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : ''}
      <p>Reply to this email if you have questions.</p>`,
  },
};

/**
 * Applies a decision. Returns { ok, message }. Notifications (in-app +
 * email) are best-effort: a failed email never undoes the decision.
 */
async function applyDecision(supabase, { userId, decision, reason, adminId }) {
  if (!DECISION_TO_STATUS[decision]) return { ok: false, message: 'Unknown decision.' };

  const [{ data: profile, error: loadErr }, { data: user }] = await Promise.all([
    supabase
      .from('provider_profiles')
      .select('user_id, full_name, application_status')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.from('users').select('id, email, role, status').eq('id', userId).maybeSingle(),
  ]);
  if (loadErr) return { ok: false, message: loadErr.message };
  if (!profile) return { ok: false, message: 'This provider has no profile yet — nothing to review.' };

  const from = profile.application_status;
  if (!TRANSITIONS[decision].includes(from)) {
    return { ok: false, message: `Can't ${decision} a provider whose status is "${from}".` };
  }
  if (decision === 'reject' && !(reason || '').trim()) {
    return { ok: false, message: 'Give a reason when rejecting — it is sent to the provider.' };
  }
  if (decision === 'approve' && user && user.status !== 'active') {
    return {
      ok: false,
      message: `The account itself is ${user.status}. Reactivate it under Users first, then approve.`,
    };
  }

  const status = DECISION_TO_STATUS[decision];
  const now = new Date().toISOString();
  const update = {
    application_status: status,
    rejection_reason: decision === 'approve' ? null : (reason || '').trim() || null,
    updated_at: now,
  };
  if (decision === 'approve') update.approved_at = now;

  // Conditional on the status we validated against, so two admins clicking
  // at once can't both apply conflicting decisions.
  const { data: changed, error: updErr } = await supabase
    .from('provider_profiles')
    .update(update)
    .eq('user_id', userId)
    .eq('application_status', from)
    .select('user_id');
  if (updErr) return { ok: false, message: updErr.message };
  if (!changed || !changed.length) {
    return { ok: false, message: 'Someone else changed this provider a moment ago — reload and check.' };
  }

  // A provider whose users.role is somehow still 'client' would be approved
  // and still land in the client half of the app.
  if (decision === 'approve' && user && user.role !== 'provider') {
    await supabase.from('users').update({ role: 'provider' }).eq('id', userId);
  }

  const { error: reviewErr } = await supabase.from('provider_application_reviews').insert({
    provider_id: userId,
    submitted_at: now,
    reviewed_by: adminId,
    decision: status,
    decision_reason: (reason || '').trim() || null,
    reviewed_at: now,
  });
  if (reviewErr) console.error('[providers] review history insert failed:', reviewErr.message);

  const copy = NOTIFY_COPY[decision];
  const { error: notifErr } = await supabase.rpc('fn_send_notification', {
    p_recipient_id: userId,
    p_type: 'application_status_change',
    p_title: copy.title,
    p_body: copy.body,
    p_rule_key: `provider_${status}`,
    // notification_log.dedupe_key is globally UNIQUE — timestamped so a
    // second decision on the same provider still notifies.
    p_dedupe_key: `provider_${status}:${userId}:${Date.now()}`,
  });
  if (notifErr) console.error('[providers] in-app notification failed:', notifErr.message);

  let emailed = false;
  if (user && user.email) {
    const mail = await sendMail({
      to: user.email,
      subject: copy.subject,
      html: copy.html(profile.full_name || 'there', (reason || '').trim()),
    });
    emailed = Boolean(mail && mail.ok);
  }

  return { ok: true, from, to: status, emailed, name: profile.full_name, email: user ? user.email : null };
}

/**
 * Hides an approved provider when their whole account is suspended or
 * deleted from the Users tab. is_publicly_listed only looks at
 * application_status, so without this a suspended/deleted user stayed
 * bookable.
 */
async function delistIfListed(supabase, userId, reason) {
  const { data } = await supabase
    .from('provider_profiles')
    .update({ application_status: 'suspended', rejection_reason: reason, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('application_status', 'approved')
    .select('user_id');
  return Boolean(data && data.length);
}

module.exports = {
  REVIEW_STATUSES,
  TRANSITIONS,
  readiness,
  rupees,
  applyDecision,
  delistIfListed,
};
