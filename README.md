# WMT HR Dashboard

Internal dashboard for Where's My Therapist: manage partner organizations,
their HR contacts, org employees, general users (clients/providers/admins),
and provider KYC review.

Standalone Express + EJS app — deliberately **not** React, and not tied into
the existing NestJS backend, so it can be built and deployed independently
and merged in later if you want.

## Two separate logins

1. **Super admin** (`/login`) — your team. A real Supabase Auth user with a
   `super_admin` row in `admin_roles`. You appoint these directly in the DB
   (insert into `admin_roles`); there's no UI to grant this, by design.
2. **HR contact** (`/hr/login`) — the partner org's own HR/welfare SPOC.
   Not a Supabase Auth user, not in `public.users` — a separate credential
   store (`organization_hr_contacts`) so there's no chance of an HR contact
   ending up mixed into the regular client/provider user base. Scoped to
   exactly one `org_id`; every HR route filters by it.

Employees onboarded through the HR portal get a genuine Supabase Auth
account (via `supabase.auth.admin.generateLink`) and land in the **consumer
app**, not this dashboard — this dashboard only tracks them.

## Setup

```bash
npm install
cp .env.example .env   # fill in Supabase + SMTP details
```

Run the migrations against your Supabase Postgres (SQL editor, or `psql
$DATABASE_URL -f migrations/001_init_hr_dashboard.sql` then `002_...sql`),
in order:

- `001_init_hr_dashboard.sql` — organizations, HR contacts, employees, leave
  requests. Nothing here touches existing tables.
- `002_add_hr_onboarding_tier.sql` — widens `subscription_tiers`'s check
  constraint (currently free/starter/growth only) and inserts a real
  `HR-Onboarding` row, mirroring Growth's limits, so it can actually be
  assigned to org employees.

Then:

```bash
npm start        # http://localhost:3100
```

First super admin: sign up a normal Supabase Auth user any way you like
(e.g. the Supabase dashboard), then:

```sql
insert into admin_roles (user_id, role_type) values ('<their-auth-uid>', 'super_admin');
```

## Deploying

You're already running the AI-chat backend on Railway's free tier
(`upbeat-blessing` project, 1/3 services used) — this fits as a second
service in the same project at no extra cost, or its own project if you'd
rather keep it fully isolated from that service. Either way:

1. Point `hr.wheresmytherapist.com` at the service via a CNAME (Railway
   custom domain) — free, just DNS, regardless of where the main domain is
   registered.
2. Don't link this subdomain from the public site; it's `noindex`'d and
   login-only, which is the access control you asked for (no VPN/IP
   allowlist needed).
3. Set the same `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` as the main
   backend, plus SMTP creds and `EMPLOYEE_REDIRECT_URL` (your consumer app's
   own auth callback).

## Deliberately out of scope right now

These match what was agreed — flagging so nothing's assumed silently fixed:

- **Leave requests** — real table, real create/list, but no approval
  routing or enforcement logic. UI only, as scoped.
- **Org reports** (sessions utilised, engagement %, wellbeing trends) —
  not implemented; dashboard shows a clearly-labeled "coming soon" instead
  of fabricated numbers.
- **General doctor (GP) feature** — `organizations.general_doctor_feature_enabled`
  is a placeholder flag only; the feature itself isn't built anywhere.
- **Automatic contract-end deactivation** — deactivating an org (button on
  the org page) *does* cascade to employees and revert their tier
  automatically. What's not built is a scheduled job that does this on its
  own when `contract_end` passes — that'd need a small cron (Railway
  supports cron services) checking for orgs past their end date daily.
- **Session-limit enforcement** — Step 3's access model/cadence is stored
  as metadata only; sessions aren't limited by tier for anyone, per your
  answer, so nothing enforces it.
