// Labels, help text, money formatting and the role -> permission map for
// the Sessions & Refunds section. Kept in one place so the backend's
// vocabulary (fault codes, reason categories, settlement states) and the
// policy wording don't drift between pages.

// super_admin = everything; finance = refunds + settlements;
// support_agent = view + outcome changes. The backend enforces the same
// rules — this only decides what the UI offers.
const PERMISSIONS = {
  super_admin: ['view', 'outcome', 'refund', 'settlement', 'retry'],
  finance: ['view', 'refund', 'settlement', 'retry'],
  support_agent: ['view', 'outcome'],
};

function can(role, action) {
  return Boolean(role && PERMISSIONS[role] && PERMISSIONS[role].includes(action));
}

/** ₹ with 2 decimals from paise. */
function inr(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '—';
  return `₹${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * "1234.5" -> 123450 paise. Strings only, no floats, so 0.1 + 0.2 style
 * rounding can never refund a paisa more or less than what was typed.
 * Returns null for anything that isn't a plain positive amount.
 */
function rupeesToPaise(input) {
  const s = String(input == null ? '' : input).replace(/[₹,\s]/g, '');
  const m = s.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
}

const SESSION_STATUS = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  in_progress: 'In progress',
  completed: 'Completed',
  no_show_client: 'Client no-show',
  no_show_provider: 'Provider no-show',
  no_show_both: 'Both absent',
  interrupted: 'Interrupted (platform)',
  cancelled_by_client: 'Cancelled by client',
  cancelled_by_provider: 'Cancelled by provider',
  rescheduled: 'Rescheduled',
  refunded: 'Refunded',
  disputed: 'Disputed',
};

const FAULTS = [
  { value: 'none', label: 'No fault — session delivered', help: 'Provider is paid their 78% as normal.' },
  { value: 'client', label: 'Client at fault', help: 'Client was absent at +30 min or caused the failure. No refund due; provider is paid.' },
  { value: 'provider', label: 'Provider at fault', help: 'Provider absent or cancelled. Client reschedules free; provider share is held, then forfeited if the client switches therapist.' },
  { value: 'both_absent', label: 'Both absent', help: 'Neither joined by +30 min.' },
  { value: 'platform_tech', label: 'Platform — tech failure', help: 'Video/app failure on our side (session marked interrupted).' },
  { value: 'platform_system', label: 'Platform — system failure', help: 'Backend, payments or scheduling failure on our side.' },
  { value: 'platform_staff', label: 'Platform — staff error', help: 'A WMT team member caused the problem.' },
  { value: 'support_error', label: 'Support agent error', help: 'Wrong action taken by support on this session.' },
];
const FAULT_LABEL = Object.fromEntries(FAULTS.map((f) => [f.value, f.label]));

const REFUND_REASONS = [
  { value: 'tech_failure', label: 'Tech failure' },
  { value: 'system_failure', label: 'System failure' },
  { value: 'staff_error', label: 'Staff error' },
  { value: 'support_agent_error', label: 'Support agent error' },
  { value: 'provider_fault', label: 'Provider fault' },
  { value: 'goodwill', label: 'Goodwill' },
  { value: 'other', label: 'Other' },
];
const REFUND_REASON_LABEL = Object.fromEntries(
  [...REFUND_REASONS, { value: 'reschedule_difference', label: 'Reschedule price difference' }].map((r) => [r.value, r.label]),
);

const SETTLEMENT_STATES = [
  { value: 'held', label: 'Held', help: 'Not payable yet — waiting on delivery or a decision.' },
  { value: 'releasable', label: 'Releasable', help: 'Provider will be paid this share in the next payout.' },
  { value: 'forfeited', label: 'Forfeited', help: 'Provider loses this share; WMT keeps it (e.g. provider fault and the client switched therapist).' },
  { value: 'voided', label: 'Voided', help: 'Cancel the settlement entirely (e.g. fully refunded session).' },
];
const SETTLEMENT_LABEL = {
  ...Object.fromEntries(SETTLEMENT_STATES.map((s) => [s.value, s.label])),
  paid: 'Paid out',
  rolled_over: 'Rolled over to reschedule',
};

const REFUND_STATUSES = ['pending', 'initiated', 'processed', 'failed'];

const SOURCE_LABEL = {
  backend: 'Backend',
  daily_webhook: 'Daily webhook',
  daily_rest: 'Daily REST',
  app: 'App',
};

const PROVIDER_LIABLE_HELP =
  "Tick when the provider caused this (no-show, late, cancelled). The refund is then recovered from the provider's 78% share for this session instead of being absorbed by WMT. Leave unticked for platform, staff, support or goodwill refunds.";

module.exports = {
  can,
  inr,
  rupeesToPaise,
  SESSION_STATUS,
  FAULTS,
  FAULT_LABEL,
  REFUND_REASONS,
  REFUND_REASON_LABEL,
  SETTLEMENT_STATES,
  SETTLEMENT_LABEL,
  REFUND_STATUSES,
  SOURCE_LABEL,
  PROVIDER_LIABLE_HELP,
};
