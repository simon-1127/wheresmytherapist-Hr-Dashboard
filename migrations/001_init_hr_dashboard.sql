-- ============================================================================
-- WMT HR Dashboard — schema additions
-- Run this against the same Supabase Postgres database as the main app.
-- Nothing here touches existing tables; it only adds new ones.
-- ============================================================================

-- ---------- Enums ----------

create type public.org_status as enum ('active', 'inactive', 'churned');
create type public.org_size_category as enum ('startup', 'sme', 'enterprise');
create type public.org_plan as enum ('starter', 'growth', 'enterprise');
create type public.employee_access_model as enum ('unlimited', 'fixed_sessions', 'pay_per_session');
create type public.session_cadence as enum ('monthly_1', 'quarterly_3', 'yearly_6', 'custom');
create type public.org_employee_status as enum ('invited', 'active', 'inactive');
create type public.hr_contact_status as enum ('active', 'disabled');

-- ---------- Organizations ----------
-- Fields map to the 10-step onboarding flow. Steps 2/4/5/6/9/10 are captured
-- as structured columns now (checkboxes -> text[], ratings -> jsonb) even
-- though no behavior is wired to them yet, so future features don't need a
-- new migration to read them.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),

  -- Step 1: basic info
  company_name text not null,
  website text,
  industry text,
  employee_count int,
  locations text[] not null default '{}',
  size_category public.org_size_category,

  -- Step 1: primary contact (WMT's own record; the HR contact does not see
  -- this back — it's for your team's reference only)
  spoc_name text,
  spoc_designation text,
  spoc_email text,
  spoc_phone text,

  -- Step 2: mental health needs assessment
  goals text[] not null default '{}',
  challenge_ratings jsonb not null default '{}',

  -- Step 3: employee coverage setup
  eligible_employees int,
  departments_covered text[] not null default '{}',
  locations_covered text[] not null default '{}',
  employee_access_model public.employee_access_model,
  session_cadence public.session_cadence,
  session_cadence_custom text,

  -- Step 4: services required
  services_therapy text[] not null default '{}',
  services_wellness text[] not null default '{}',
  services_emergency text[] not null default '{}',

  -- Step 5: platform setup
  access_methods text[] not null default '{}',
  auth_method text,

  -- Step 6: confidentiality agreement
  confidentiality_agreed boolean not null default false,
  confidentiality_agreed_at timestamptz,

  -- Step 8: commercial setup
  plan public.org_plan,
  subscription_tier_id text references public.subscription_tiers(id),
  general_doctor_feature_enabled boolean not null default false, -- placeholder, feature not built yet
  billing_address text,
  gst_number text,
  invoice_email text,
  payment_terms text,
  contract_start date,
  contract_end date,

  -- Step 9: employee launch
  launch_date date,
  communication_preference text[] not null default '{}',
  logo_url text,
  hr_communication_guidelines_url text,

  -- meta
  status public.org_status not null default 'active',
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_organizations_status on public.organizations(status);

-- ---------- HR contacts ----------
-- The org's own HR/welfare SPOC. NOT a Supabase Auth user and NOT in
-- public.users — a separate, minimal credential store so there's no chance
-- of an HR contact ending up mixed into the regular client/provider user base.

create table public.organization_hr_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text,
  designation text,
  email text not null unique,
  phone text,
  password_hash text not null,
  must_reset_password boolean not null default true,
  status public.hr_contact_status not null default 'active',
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- ---------- Employees ----------
-- Employees ARE regular `client`-role rows in public.users once they verify
-- (via magic link), but are tracked here separately so this dashboard never
-- mixes them into the general/organic client list.

create table public.organization_employees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references public.users(id), -- filled in once they verify
  email text not null,
  status public.org_employee_status not null default 'invited',
  added_by_hr_contact_id uuid references public.organization_hr_contacts(id),
  added_by_admin_id uuid references public.users(id),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  deactivated_at timestamptz,
  unique (org_id, email)
);

create index idx_org_employees_org on public.organization_employees(org_id);
create index idx_org_employees_user on public.organization_employees(user_id);

-- ---------- Leave requests ----------
-- UI-only per current scope — table exists so the UI has somewhere real to
-- write to, but nothing in the app enforces or routes these anywhere yet.

create table public.organization_leave_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.organization_employees(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text,
  status text not null default 'pending', -- pending / approved / rejected
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- updated_at trigger for organizations ----------

create or replace function public.fn_touch_org_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_organizations_touch_updated_at
  before update on public.organizations
  for each row execute function public.fn_touch_org_updated_at();

-- ---------- RLS ----------
-- All access to these tables goes through the dashboard's backend using the
-- Supabase service role key (same pattern as the rest of the app's
-- privileged writes), so RLS stays enabled with no public policies —
-- nothing here is reachable from client-side keys.

alter table public.organizations enable row level security;
alter table public.organization_hr_contacts enable row level security;
alter table public.organization_employees enable row level security;
alter table public.organization_leave_requests enable row level security;
