-- Part 1b: links an invited employee's auth account back to their
-- organization_employees row, and gives them their org's subscription
-- tier — neither happens anywhere today (grepped both codebases; the
-- user_id/status/joined_at columns on organization_employees are never
-- written by anything, and client_profiles.subscription_tier is never set
-- to anything but the 'free' default).
--
-- Runs as a BEFORE INSERT trigger on client_profiles rather than from the
-- Flutter client, for two reasons: (1) organization_employees has no RLS
-- policy letting an ordinary authenticated client write to it — this is
-- deliberately locked to the HR dashboard's service-role key — so a
-- client-side update would just fail; (2) setting the tier has to happen
-- BEFORE the row lands (client_profiles.subscription_tier is NOT NULL
-- with no way to patch it in after the fact without a second write).
--
-- SECURITY DEFINER (same pattern as handle_new_auth_user) so this can read
-- organizations/organization_employees despite the calling client having
-- no direct access to either.

CREATE FUNCTION public.fn_link_org_employee_on_profile_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_email text;
  v_org_id uuid;
  v_tier_id text;
BEGIN
  SELECT email INTO v_email FROM public.users WHERE id = NEW.user_id;
  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only matches a row that's still 'invited' and unlinked — a second
  -- profile-creation attempt, or an email reused after being deactivated,
  -- never re-links or reactivates anything here.
  SELECT org_id INTO v_org_id
  FROM public.organization_employees
  WHERE email = v_email AND user_id IS NULL AND status = 'invited'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN NEW; -- ordinary self-signup client, or an already-linked employee
  END IF;

  UPDATE public.organization_employees
  SET user_id = NEW.user_id, status = 'active', joined_at = now()
  WHERE org_id = v_org_id AND email = v_email AND user_id IS NULL AND status = 'invited';

  SELECT subscription_tier_id INTO v_tier_id FROM public.organizations WHERE id = v_org_id;
  IF v_tier_id IS NOT NULL THEN
    NEW.subscription_tier := v_tier_id; -- FK-safe: both columns reference subscription_tiers(id)
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_link_org_employee_on_profile_create
  BEFORE INSERT ON public.client_profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_link_org_employee_on_profile_create();
