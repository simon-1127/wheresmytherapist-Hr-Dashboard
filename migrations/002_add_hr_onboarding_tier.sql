-- ============================================================================
-- Adds the HR-Onboarding subscription tier as a real row in subscription_tiers
-- so it can actually be assigned to org employees. subscription_tiers.id
-- currently has a CHECK constraint limiting it to free/starter/growth —
-- this widens it, then inserts the tier.
--
-- Limits mirror Growth (per "fullest access" — full wellness access,
-- MediTrack, priority booking, all languages, top AI limits). The
-- not-yet-built "general doctor" (GP) feature is tracked separately, on
-- organizations.general_doctor_feature_enabled — it isn't part of the
-- per-user tier model since it doesn't exist yet.
-- ============================================================================

alter table public.subscription_tiers
  drop constraint subscription_tiers_id_check;

alter table public.subscription_tiers
  add constraint subscription_tiers_id_check
  check (id = any (array['free'::text, 'starter'::text, 'growth'::text, 'HR-Onboarding'::text]));

insert into public.subscription_tiers (
  id, display_name, journal_entry_limit, journal_entry_max_chars, wellness_access,
  meditrack_access, priority_booking, allowed_language_codes, sort_order,
  ai_chats_per_day, ai_max_tokens_per_conversation, ai_max_output_tokens_per_message, ai_priority
) values (
  'HR-Onboarding', 'HR Onboarding', null, null, 'full',
  true, true, null, 3,
  300, 300000, 1200, true
)
on conflict (id) do nothing;
