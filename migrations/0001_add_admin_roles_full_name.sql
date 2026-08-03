-- Adds the missing name field for WMT team members (support_agent /
-- content_moderator / finance). Nullable so existing rows (created before
-- this migration) aren't broken — the dashboard shows "—" for those until
-- someone re-adds them or you backfill manually.
--
-- Run this against Supabase (SQL editor, or via the CLI/migration tool
-- you normally use) BEFORE deploying the updated src/ folder — the new
-- code writes to this column immediately on the next team-member invite.

ALTER TABLE public.admin_roles
  ADD COLUMN IF NOT EXISTS full_name text;
