-- Part 4: Razorpay pipeline for subscription tier upgrades. Separate from
-- the existing session-booking payment flow — payments.session_id is
-- NOT NULL, so that table is hard-scoped to bookings and can't represent
-- a standalone tier purchase. subscription_tiers also has no price at all
-- today. Both gaps closed here; nothing about the booking payment flow
-- changes.

-- ---------------------------------------------------------------------
-- 1. Pricing. Nullable — free and HR-Onboarding aren't self-purchasable,
--    so those rows simply stay NULL and the app treats NULL as
--    "not available to buy" rather than needing a separate flag.
--    No currency column, matching the rest of the schema (payments,
--    provider_profiles etc.) — everything here is INR-only today.
-- ---------------------------------------------------------------------
ALTER TABLE public.subscription_tiers
  ADD COLUMN IF NOT EXISTS price_amount integer; -- paise/month

-- ---------------------------------------------------------------------
-- 2. subscription_payments — mirrors `payments` (same status enum, same
--    "written only by the edge function / webhook, read-only for the
--    client" shape) but keyed to a tier purchase instead of a session.
-- ---------------------------------------------------------------------
CREATE TABLE public.subscription_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id),
    tier_id text NOT NULL REFERENCES public.subscription_tiers(id),
    razorpay_order_id text NOT NULL,
    razorpay_payment_id text,
    status public.payment_status DEFAULT 'created'::public.payment_status NOT NULL,
    amount integer NOT NULL,
    method text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_payments_select_own ON public.subscription_payments
  FOR SELECT USING (auth.uid() = user_id);
-- No insert/update policy, same as `payments` — every write goes through
-- the create-tier-upgrade-order edge function and its webhook handler
-- using the service role, never the client directly.

-- ---------------------------------------------------------------------
-- 3. Client-side bug found while wiring this up, unrelated to payments
--    itself: ClientTier (the app's Dart enum mirroring subscription_tiers)
--    has no case for 'HR-Onboarding'. clientTierFromId() silently maps it
--    to ClientTier.free, so an HR-linked employee's tier lookup in
--    currentTierInfoProvider (repository_providers.dart) matches on
--    ClientTier.free and could resolve to whichever row — the real 'free'
--    tier or their actual 'HR-Onboarding' one — happens to come first in
--    sort_order, rather than deterministically their own entitlements.
--    This doesn't touch the payments migration itself, but the #4
--    employee-linking fix from last step only pays off correctly once the
--    client can actually distinguish the tier it just assigned — fixed in
--    the same app delivery as this step (see subscription_tier.dart).
