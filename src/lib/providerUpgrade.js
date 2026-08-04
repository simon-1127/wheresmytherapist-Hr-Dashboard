const { generateTempPassword } = require('./passwords');

// Upgrading an existing account to a provider is not just a role flip — it
// changes which half of the app the person lands in on next login
// (app_router.dart gates on users.role), and the client-side data they had
// stops being reachable from their own account. Everything below exists to
// make that consequence visible before it happens, rather than discovering
// it from a confused user.
//
// Note that client_profiles is NEVER deleted here. Ten tables reference
// client_profiles(user_id) — journal_entries, crisis_alerts, sessions,
// survey_responses, reviews and more — so removing it would either fail
// outright or take real clinical history with it. The row stays; the
// account simply stops routing to the client experience.

const UPCOMING_SESSION_STATUSES = ['pending_payment', 'confirmed', 'in_progress'];

function ageFrom(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

/**
 * Gathers everything that should be known before flipping a user to
 * provider. Returns blockers (upgrade is refused) and warnings (upgrade is
 * allowed, but the admin has to tick the acknowledgement box).
 */
async function preflightUpgrade(supabase, userId) {
  const [
    { data: user },
    { data: clientProfile },
    { data: providerProfile },
    { data: adminRole },
    { count: upcomingSessions },
    { count: pastSessions },
    { data: orgLink },
    { count: openAlerts },
  ] = await Promise.all([
    supabase.from('users').select('id, role, email, phone, status, created_at, deleted_at').eq('id', userId).maybeSingle(),
    supabase.from('client_profiles').select('user_id, full_name, date_of_birth, subscription_tier, preferred_language').eq('user_id', userId).maybeSingle(),
    supabase.from('provider_profiles').select('user_id, full_name, application_status, kyc_status, created_at').eq('user_id', userId).maybeSingle(),
    supabase.from('admin_roles').select('role_type').eq('user_id', userId).maybeSingle(),
    supabase
      .from('sessions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', userId)
      .in('status', UPCOMING_SESSION_STATUSES)
      .gt('scheduled_start', new Date().toISOString()),
    supabase.from('sessions').select('id', { count: 'exact', head: true }).eq('client_id', userId),
    supabase
      .from('organization_employees')
      .select('id, org_id, status, organizations(company_name)')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('crisis_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['new', 'acknowledged']),
  ]);

  const blockers = [];
  const warnings = [];
  // Notes are always-true consequences of any upgrade. They're shown, but
  // they don't gate the acknowledgement checkbox — if every upgrade tripped
  // it, ticking it would stop meaning anything and the genuinely unusual
  // cases below would lose their signal.
  const notes = [];
  const age = clientProfile ? ageFrom(clientProfile.date_of_birth) : null;

  if (!user) {
    blockers.push('No such user.');
    return { user: null, clientProfile: null, providerProfile: null, blockers, warnings, notes, age, counts: {} };
  }

  if (user.deleted_at || user.status === 'deleted') {
    blockers.push('This account is deleted.');
  }
  if (user.status === 'suspended') {
    blockers.push('This account is suspended. Reactivate it first if the upgrade is intended.');
  }
  if (user.role === 'provider') {
    blockers.push('This user is already a provider.');
  }
  if (user.role === 'admin' || adminRole) {
    blockers.push(
      `This account is WMT staff${adminRole ? ` (${adminRole.role_type.replace('_', ' ')})` : ''}. ` +
        'Staff accounts should not also be providers — create a separate provider account instead.',
    );
  }
  if (providerProfile) {
    blockers.push(
      `A provider profile already exists for this user (status: ${providerProfile.application_status}). ` +
        'Use the Providers tab to review it.',
    );
  }
  if (!clientProfile && user.role === 'client') {
    blockers.push('This client has no client_profiles row — the account looks half-created. Investigate before upgrading.');
  }
  if (age !== null && age < 18) {
    blockers.push(`This user is ${age}. Minors cannot be onboarded as providers.`);
  }
  // Their booked sessions live under client_id and would become unreachable
  // from an account that now routes to the provider side — with a paid,
  // scheduled appointment attached. Refund or complete them first.
  if (upcomingSessions) {
    blockers.push(
      `${upcomingSessions} upcoming session${upcomingSessions === 1 ? '' : 's'} booked as a client. ` +
        'Cancel, refund or complete them before upgrading.',
    );
  }

  if (orgLink) {
    warnings.push(
      `Linked to ${orgLink.organizations ? orgLink.organizations.company_name : 'an organization'} as an employee. ` +
        'Their employer-sponsored tier stops applying once they are a provider.',
    );
  }
  if (clientProfile && clientProfile.subscription_tier && clientProfile.subscription_tier.toLowerCase() !== 'free') {
    warnings.push(
      `Currently on the ${clientProfile.subscription_tier} tier. Billing is not cancelled by this upgrade — handle it separately.`,
    );
  }
  if (openAlerts) {
    warnings.push(
      `${openAlerts} unresolved crisis alert${openAlerts === 1 ? '' : 's'} on this account. ` +
        'Confirm with the support team before making this person a provider.',
    );
  }
  if (pastSessions) {
    notes.push(
      `${pastSessions} past session${pastSessions === 1 ? '' : 's'} as a client. ` +
        'That history is retained but will no longer be visible from their own account.',
    );
  }
  if (clientProfile) {
    notes.push(
      'Client data (journal, check-ins, AI chats) is retained in the database but stops being reachable from the app once the account routes to the provider side.',
    );
  }

  return {
    user,
    clientProfile,
    providerProfile,
    adminRole,
    blockers,
    warnings,
    notes,
    age,
    counts: {
      upcomingSessions: upcomingSessions || 0,
      pastSessions: pastSessions || 0,
      openAlerts: openAlerts || 0,
    },
    orgLink,
  };
}

/**
 * Performs the upgrade.
 *
 * Order is deliberate: provider_profiles is inserted BEFORE users.role is
 * flipped. A provider with no provider_profiles row is a hard crash on the
 * app's provider routes, so if only one of the two writes can land it must
 * be the profile. If the role flip then fails, the just-created draft
 * profile is rolled back so a retry starts clean.
 */
async function upgradeToProvider(supabase, { userId, fullName }) {
  // password_set_by_provider is true here, unlike the create-from-scratch
  // flow in onboarding.routes.js — this person already has their own
  // password and never receives a temporary one, so sending them through
  // the app's "set your password" step would be wrong.
  const { error: insertErr } = await supabase.from('provider_profiles').insert({
    user_id: userId,
    full_name: fullName,
    // NOT NULL with no defaults; the provider replaces these on the
    // profile-setup screen. base_session_rate has a CHECK (> 0).
    professional_title: 'Not yet provided',
    years_experience: 0,
    base_session_rate: 1,
    application_status: 'draft',
    // Both of these have DB defaults, but they're written explicitly because
    // preflightRevert treats them as the definition of "nothing has happened
    // yet" — leaving that to an implicit default makes the revert precondition
    // depend on schema trivia.
    kyc_status: 'not_started',
    profile_completed_by_provider: false,
    password_set_by_provider: true,
  });
  if (insertErr) {
    return { ok: false, stage: 'provider_profiles', message: insertErr.message };
  }

  const { error: roleErr } = await supabase.from('users').update({ role: 'provider' }).eq('id', userId);
  if (roleErr) {
    await supabase.from('provider_profiles').delete().eq('user_id', userId);
    return { ok: false, stage: 'users.role', message: roleErr.message };
  }

  return { ok: true };
}

/**
 * Undo, for the case where the wrong account was upgraded. Only safe while
 * the provider has done nothing yet — the moment they have availability,
 * sessions, payouts or a submitted application, unwinding this is no longer
 * a two-row change and should be handled deliberately rather than by a
 * button.
 */
async function preflightRevert(supabase, userId) {
  const [
    { data: providerProfile },
    { data: clientProfile },
    { count: providerSessions },
    { count: slots },
    { count: payouts },
  ] = await Promise.all([
    supabase.from('provider_profiles').select('user_id, application_status, kyc_status').eq('user_id', userId).maybeSingle(),
    supabase.from('client_profiles').select('user_id').eq('user_id', userId).maybeSingle(),
    supabase.from('sessions').select('id', { count: 'exact', head: true }).eq('provider_id', userId),
    supabase.from('availability_slots').select('id', { count: 'exact', head: true }).eq('provider_id', userId),
    supabase.from('payouts').select('id', { count: 'exact', head: true }).eq('provider_id', userId),
  ]);

  const blockers = [];
  if (!providerProfile) blockers.push('No provider profile to revert.');
  if (providerProfile && providerProfile.application_status !== 'draft') {
    blockers.push(`Application status is "${providerProfile.application_status}" — only an untouched draft can be reverted here.`);
  }
  if (providerProfile && providerProfile.kyc_status && providerProfile.kyc_status !== 'not_started') {
    blockers.push(`KYC has already started (${providerProfile.kyc_status}).`);
  }
  if (providerSessions) blockers.push(`${providerSessions} session(s) already exist against this provider.`);
  if (slots) blockers.push(`${slots} availability slot(s) already published.`);
  if (payouts) blockers.push(`${payouts} payout record(s) exist.`);
  if (!clientProfile) {
    blockers.push('No client_profiles row to return them to — this account was never a client.');
  }

  return { providerProfile, blockers };
}

async function revertToClient(supabase, userId) {
  const { error: roleErr } = await supabase.from('users').update({ role: 'client' }).eq('id', userId);
  if (roleErr) return { ok: false, stage: 'users.role', message: roleErr.message };

  const { error: delErr } = await supabase.from('provider_profiles').delete().eq('user_id', userId);
  if (delErr) {
    // Role is already back to client; leaving the empty draft profile behind
    // is harmless (nothing lists a draft) and is reported rather than hidden.
    return { ok: false, stage: 'provider_profiles', message: delErr.message };
  }
  return { ok: true };
}

module.exports = {
  preflightUpgrade,
  upgradeToProvider,
  preflightRevert,
  revertToClient,
  ageFrom,
  generateTempPassword,
};
