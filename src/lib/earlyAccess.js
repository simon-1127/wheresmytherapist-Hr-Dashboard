/**
 * Early-access waitlists for features that aren't live yet. Each entry is a
 * public.<table> filled by the website (one row per account) plus follow-up
 * columns this dashboard owns. Option values mirror the table's CHECK
 * constraints (backend db/migrations/007_physio_waitlist.sql) and the
 * website's lib/physio.ts — change all three together.
 */

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

const PHYSIO = {
  key: 'physiotherapy',
  table: 'physio_waitlist',
  title: 'Home physiotherapy',
  blurb: 'Waitlist from the website’s /physiotherapy page (open to everyone; signing in is optional). Planned price from ₹1,000/session.',
  options: {
    for_whom: opts([
      ['self', 'Myself'],
      ['parent_elderly', 'Parent / elderly family member'],
      ['other_family', 'Other family member'],
      ['someone_else', 'Exploring for someone else'],
    ]),
    timing: opts([
      ['asap', 'As soon as available'],
      ['within_month', 'Within a month'],
      ['one_to_three_months', 'Within 1–3 months'],
      ['researching', 'Just researching'],
    ]),
    support: opts([
      ['mobility', 'Mobility, balance or strength'],
      ['post_injury_surgery', 'Recovery after injury / surgery'],
      ['elderly_support', 'Support for an elderly person'],
      ['general', 'General enquiry'],
      ['not_sure', 'Not sure yet'],
    ]),
    price_fit: opts([
      ['yes', 'Yes, would consider ₹1,000'],
      ['maybe', 'Maybe, depends on details'],
      ['no', 'Above budget'],
      ['more_info', 'Wants more info first'],
    ]),
  },
  /** Every column stored, in order — drives the detail page and "What we store". */
  fields: [
    { col: 'name', label: 'Name', from: 'customer', note: 'As typed on the form (pre-filled from their profile).' },
    { col: 'contact', label: 'Email or phone', from: 'customer', note: 'How they asked to be reached. May differ from the account email.' },
    { col: 'city', label: 'City', from: 'customer', note: 'City only — the form tells people not to enter an address.' },
    { col: 'state', label: 'State', from: 'customer' },
    { col: 'for_whom', label: 'Who needs it', from: 'customer', option: true },
    { col: 'timing', label: 'When they’d use it', from: 'customer', option: true },
    { col: 'support', label: 'Support wanted', from: 'customer', option: true },
    { col: 'price_fit', label: '₹1,000 price fit', from: 'customer', option: true },
    { col: 'note', label: 'Anything else', from: 'customer', note: 'Optional, max 1,000 chars. People are asked not to share medical details.' },
    { col: 'contact_consent_at', label: 'Contact consent', from: 'customer', date: true, note: 'When they ticked “WMT may contact me”. Required to submit.' },
    { col: 'user_id', label: 'Account', from: 'system', note: 'users.id if they were signed in (one entry per account; resubmitting updates it). Empty = joined without an account; linked automatically if they later sign up with the same verified email.' },
    { col: 'created_at', label: 'Joined', from: 'system', date: true },
    { col: 'updated_at', label: 'Last updated by customer', from: 'system', date: true },
    { col: 'status', label: 'Follow-up status', from: 'team' },
    { col: 'staff_note', label: 'Team note', from: 'team', note: 'Internal only, max 2,000 chars. Never shown to the customer.' },
    { col: 'contacted_at', label: 'First contacted', from: 'team', date: true, note: 'Set automatically the first time status leaves “New”.' },
    { col: 'handled_by', label: 'Handled by', from: 'team', note: 'Admin who last changed the follow-up.' },
  ],
};

const FEATURES = { [PHYSIO.key]: PHYSIO };

const STATUSES = opts([
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['follow_up', 'Follow up'],
  ['not_interested', 'Not interested'],
  ['converted', 'Converted'],
]);
const STATUS_BADGE = { new: 'badge-info', contacted: 'badge-neutral', follow_up: 'badge-warn', not_interested: 'badge-danger', converted: 'badge-success' };

function labelOf(feature, col, value) {
  const list = col === 'status' ? STATUSES : feature.options[col];
  const hit = list && list.find((o) => o.value === value);
  return hit ? hit.label : value || '—';
}

/** CSV cell: quote everything; neutralise spreadsheet formulas (=, +, -, @). */
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

module.exports = { FEATURES, STATUSES, STATUS_BADGE, labelOf, csvCell };
