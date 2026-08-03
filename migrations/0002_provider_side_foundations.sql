-- Foundations for the provider-side app: role/onboarding-routing fix (#3)
-- plus the RLS a provider needs to manage their own availability and see
-- their own payouts. Nothing here touches client-facing tables/policies.

-- ---------------------------------------------------------------------
-- 1. Onboarding routing fix (#3)
-- ---------------------------------------------------------------------
-- Distinguishes "provider filled this in themselves" from "admin created
-- a placeholder row for them" without touching application_status (which
-- has its own, unrelated meaning). Defaults to true so every EXISTING row
-- (all of them self-signup, since the admin-created path is what's being
-- fixed) is completely unaffected — the router's new check below is a
-- no-op for anyone already in the system.
ALTER TABLE public.provider_profiles
  ADD COLUMN IF NOT EXISTS profile_completed_by_provider boolean NOT NULL DEFAULT true;

-- The HR dashboard's admin-created-provider endpoint (onboarding.routes.js)
-- needs a matching two-line change: set this to false on that insert, and
-- set public.users.role = 'provider' right after creating the auth user
-- (it currently never does — see the plan notes). Both are small enough
-- to hand-edit rather than regenerate the whole src/ zip for.

-- ---------------------------------------------------------------------
-- 2. Availability management — providers currently have NO policy letting
--    them write their own slots at all (only a SELECT policy exists,
--    scoped to open/held slots for the BOOKING client's view). Delete is
--    restricted to 'open' slots only — never allows removing a slot a
--    client has already held or booked out from under them.
-- ---------------------------------------------------------------------
CREATE POLICY availability_slots_insert_own ON public.availability_slots
  FOR INSERT WITH CHECK (auth.uid() = provider_id);

CREATE POLICY availability_slots_delete_own ON public.availability_slots
  FOR DELETE USING (auth.uid() = provider_id AND status = 'open');

-- ---------------------------------------------------------------------
-- 3. Payouts — no SELECT policy exists yet, so a provider currently can't
--    read their own payout history at all (RLS default-deny). Read-only:
--    payouts/payout_line_items are written by your payout-processing job,
--    never by the provider directly.
-- ---------------------------------------------------------------------
CREATE POLICY payouts_select_own ON public.payouts
  FOR SELECT USING (auth.uid() = provider_id);

CREATE POLICY payout_line_items_select_own ON public.payout_line_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.payouts p
      WHERE p.id = payout_line_items.payout_id AND p.provider_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- 4. Provider bookings list needs the client's name. client_profiles
--    currently has no policy letting anyone but the client themselves read
--    their own row — a provider joining client_profiles(full_name) for
--    their sessions list would silently get null names back (PostgREST
--    embeds return empty on an RLS-blocked join, not an error). Scoped
--    narrowly: a provider can read a client's name ONLY if a session
--    exists between them, never client_profiles generally.
-- ---------------------------------------------------------------------
CREATE POLICY client_profiles_select_as_provider ON public.client_profiles
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.sessions s
      WHERE s.client_id = client_profiles.user_id AND s.provider_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- Note, not fixed here (flagging, not silently patching — worth its own
-- reviewed migration): provider_profiles_update_own currently has no
-- column restriction, so a provider can update ANY column on their own
-- row via the plain client SDK today, including kyc_status,
-- application_status, rating_avg, razorpay_contact_id/fund_account_id.
-- The new payout-setup flow below deliberately never writes those columns
-- from the client (it goes through an edge function using the service
-- role) — but the underlying policy gap predates this change and still
-- lets a provider set e.g. application_status = 'approved' directly.
-- Worth a column-level policy or a BEFORE UPDATE trigger locking those
-- specific columns to service_role only.
