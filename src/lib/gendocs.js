// General doctor (GenDoc) helpers. No payment anywhere in this flow —
// consults are billed to the organization outside the app.
//
// Visibility rule (enforced by RLS): an employee sees a doctor only when
// the doctor is 'approved' AND actively assigned to the employee's org.
// Joining the queue additionally needs is_accepting_queue, a working day,
// and room before the doctor's day ends (sql/2026-10-04_gendoc_pipeline.sql).

const { sendMail } = require('../config/mailer');
const { escapeHtml } = require('./validate');

const REVIEW_STATUSES = ['draft', 'submitted', 'under_review'];
const TRANSITIONS = {
  approve: ['draft', 'submitted', 'under_review', 'rejected', 'suspended'],
  reject: ['draft', 'submitted', 'under_review'],
  suspend: ['approved'],
};
const DECISION_TO_STATUS = { approve: 'approved', reject: 'rejected', suspend: 'suspended' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** YYYY-MM-DD for "today" in the doctor's own timezone. */
function todayIn(tz) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz || 'Asia/Kolkata' });
  } catch {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }
}

function readiness(g, extras = {}) {
  if (!g) return { items: [], missing: 0, ready: false };
  const items = [
    { label: 'Full name', ok: Boolean(g.full_name && g.full_name.trim().length > 1) },
    { label: 'Professional title', ok: Boolean(g.professional_title && g.professional_title.trim()) },
    { label: 'Registration no.', ok: Boolean(g.registration_no && g.registration_no.trim()) },
    { label: 'Registration council', ok: Boolean(g.registration_council && g.registration_council.trim()) },
    { label: 'Qualifications', ok: Array.isArray(g.qualifications) && g.qualifications.length > 0 },
    { label: 'Bio', ok: Boolean(g.bio && g.bio.trim().length >= 20) },
    { label: 'Photo', ok: Boolean(g.photo_url) },
    { label: 'Profile completed by doctor', ok: g.profile_completed_by_gendoc !== false },
    { label: 'Own password set', ok: g.password_set_by_gendoc !== false },
  ];
  if (extras.languages !== undefined) items.push({ label: 'At least one language', ok: extras.languages > 0 });
  if (extras.schedule !== undefined) items.push({ label: 'Working hours saved', ok: Boolean(extras.schedule) });
  const missing = items.filter((i) => !i.ok).length;
  return { items, missing, ready: missing === 0 };
}

async function notify(supabase, recipientId, title, body, key) {
  const { error } = await supabase.rpc('fn_send_notification', {
    p_recipient_id: recipientId,
    p_type: key.startsWith('gendoc_queue') ? 'announcement' : 'application_status_change',
    p_title: title,
    p_body: body,
    p_rule_key: key,
    p_dedupe_key: `${key}:${recipientId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
  });
  if (error) console.error('[gendocs] notification failed:', error.message);
}

/**
 * Cancels waiting (and optionally in-progress) entries for today and tells
 * each employee. Used when a doctor is suspended, or removed from an org.
 * Returns the number of people affected.
 */
async function cancelTodaysQueue(supabase, { gendocId, tz, orgId = null, adminId, why }) {
  const today = todayIn(tz);
  let q = supabase
    .from('gendoc_queue_entries')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: adminId, updated_at: new Date().toISOString() })
    .eq('gendoc_id', gendocId)
    .eq('queue_date', today)
    .eq('status', 'waiting');
  if (orgId) q = q.eq('org_id', orgId);
  const { data, error } = await q.select('id, client_id');
  if (error) {
    console.error('[gendocs] queue cancel failed:', error.message);
    return 0;
  }
  for (const row of data || []) {
    await notify(supabase, row.client_id, 'Consultation cancelled', why, 'gendoc_queue_cancelled');
  }
  await supabase.rpc('fn_recompute_gendoc_queue', { p_gendoc_id: gendocId, p_date: today });
  return (data || []).length;
}

const COPY = {
  approve: {
    title: 'Profile approved',
    body: 'Your doctor profile is approved. Employees of your assigned organizations can now see you.',
    subject: "You're approved — Where's My Therapist",
    html: (n) => `<p>Hi ${escapeHtml(n)},</p><p>Your doctor profile on Where's My Therapist is approved. Employees of the organizations assigned to you can now see you and join your queue during your working hours.</p><p>Check your working hours and lunch break in the app.</p>`,
  },
  reject: {
    title: 'Profile update needed',
    body: 'Your doctor profile was not approved yet. Check your email for details.',
    subject: "Your profile — Where's My Therapist",
    html: (n, r) => `<p>Hi ${escapeHtml(n)},</p><p>We couldn't approve your doctor profile yet.</p>${r ? `<p><strong>Reason:</strong> ${escapeHtml(r)}</p>` : ''}<p>Update your profile in the app and we'll review it again.</p>`,
  },
  suspend: {
    title: 'Profile paused',
    body: 'Your profile is temporarily hidden from employees.',
    subject: "Your profile is paused — Where's My Therapist",
    html: (n, r) => `<p>Hi ${escapeHtml(n)},</p><p>Your doctor profile has been temporarily hidden from employees and today's waiting queue was cancelled.</p>${r ? `<p><strong>Reason:</strong> ${escapeHtml(r)}</p>` : ''}`,
  },
};

async function applyDecision(supabase, { userId, decision, reason, adminId }) {
  if (!DECISION_TO_STATUS[decision]) return { ok: false, message: 'Unknown decision.' };
  const [{ data: g }, { data: user }] = await Promise.all([
    supabase.from('gendoc_profiles').select('user_id, full_name, application_status, timezone').eq('user_id', userId).maybeSingle(),
    supabase.from('users').select('id, email, status').eq('id', userId).maybeSingle(),
  ]);
  if (!g) return { ok: false, message: 'No such doctor.' };
  const from = g.application_status;
  if (!TRANSITIONS[decision].includes(from)) return { ok: false, message: `Can't ${decision} a doctor whose status is "${from}".` };
  const why = String(reason || '').trim();
  if (decision === 'reject' && why.length < 5) return { ok: false, message: 'Give a reason (5+ characters) — it is sent to the doctor.' };
  if (decision === 'approve' && user && user.status !== 'active') {
    return { ok: false, message: `The account is ${user.status}. Reactivate it under Users first.` };
  }

  const status = DECISION_TO_STATUS[decision];
  const now = new Date().toISOString();
  const update = { application_status: status, rejection_reason: decision === 'approve' ? null : why || null, updated_at: now };
  if (decision === 'approve') update.approved_at = now;

  const { data: changed, error } = await supabase
    .from('gendoc_profiles')
    .update(update)
    .eq('user_id', userId)
    .eq('application_status', from)
    .select('user_id');
  if (error) return { ok: false, message: error.message };
  if (!changed || !changed.length) return { ok: false, message: 'Someone else changed this doctor a moment ago — reload.' };

  let cancelled = 0;
  if (decision === 'suspend') {
    cancelled = await cancelTodaysQueue(supabase, {
      gendocId: userId,
      tz: g.timezone,
      adminId,
      why: "Your doctor consultation for today was cancelled because the doctor is unavailable. We're sorry for the inconvenience.",
    });
  }

  const c = COPY[decision];
  await notify(supabase, userId, c.title, c.body, `gendoc_${status}`);
  let emailed = false;
  if (user && user.email) {
    const m = await sendMail({ to: user.email, subject: c.subject, html: c.html(g.full_name || 'Doctor', why) });
    emailed = Boolean(m.ok);
  }
  return { ok: true, from, to: status, cancelled, emailed, name: g.full_name };
}

/** Hide an approved doctor when their whole account is suspended/deleted. */
async function delistIfListed(supabase, userId, reason) {
  const { data } = await supabase
    .from('gendoc_profiles')
    .update({ application_status: 'suspended', rejection_reason: reason, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('application_status', 'approved')
    .select('user_id, timezone');
  if (!data || !data.length) return false;
  await cancelTodaysQueue(supabase, {
    gendocId: userId,
    tz: data[0].timezone,
    adminId: null,
    why: "Your doctor consultation for today was cancelled because the doctor is unavailable. We're sorry for the inconvenience.",
  });
  return true;
}

function validateSchedule(b) {
  const t = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? v : null);
  const dayStart = t(b.day_start);
  const dayEnd = t(b.day_end);
  const lunchStart = t(b.lunch_start);
  const lunchEnd = t(b.lunch_end);
  const minutes = parseInt(b.consultation_minutes, 10);
  const days = [].concat(b.working_days || b['working_days[]'] || []).map(Number).filter((d) => d >= 0 && d <= 6);

  if (!dayStart || !dayEnd) return { error: 'Start and end of day are both required.' };
  if (dayEnd <= dayStart) return { error: 'The day must end after it starts.' };
  if (Boolean(lunchStart) !== Boolean(lunchEnd)) return { error: 'Give both a lunch start and end, or neither.' };
  if (lunchStart && (lunchEnd <= lunchStart || lunchStart < dayStart || lunchEnd > dayEnd)) {
    return { error: 'Lunch must end after it starts and sit inside the working day.' };
  }
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) return { error: 'Consultation length must be 5–120 minutes.' };
  if (!days.length) return { error: 'Pick at least one working day.' };
  return {
    schedule: { day_start: dayStart, day_end: dayEnd, lunch_start: lunchStart, lunch_end: lunchEnd, working_days: [...new Set(days)].sort() },
    minutes,
  };
}

module.exports = {
  REVIEW_STATUSES,
  TRANSITIONS,
  DAY_NAMES,
  todayIn,
  readiness,
  applyDecision,
  cancelTodaysQueue,
  delistIfListed,
  validateSchedule,
  notify,
};
