-- 0004_force_rls's `when` in meta/_journal.json was 1777644000000 — later
-- than 0005 (1777556981319) and 0006 (1777560625125). Drizzle's migrator
-- compares each entry's folderMillis against the latest applied row's
-- created_at, so once 0004 was applied, 0005 and 0006 looked already-applied
-- and were silently skipped on every subsequent migrate run. This is what
-- caused `column "table_access" does not exist` against dev Neon.
--
-- We renumbered 0004's `when` to 1777549868012 (just after 0003) so the
-- sequence is monotonic. This migration brings any DB up to date:
--   1. Updates 0004's stored created_at to match the new `when`.
--   2. Defensively re-applies 0005's and 0006's schema (IF NOT EXISTS) and
--      backfills their journal rows so a DB that got stuck at 0004 catches
--      up in one shot. No-op on a fresh DB or on dev (already manually
--      patched).
--
-- Hand-written; registered in meta/_journal.json.

UPDATE drizzle.__drizzle_migrations
  SET created_at = 1777549868012
  WHERE hash = '5c37176540ec6df8e34ec79dd8f876c649b81a4c7171723b040133da93c78993';

ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "name" text;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
  SELECT '52f8bb4fa4159440cfcb8e8d07fc0f870b8f7f2d4ac3125cb68065377bd50c45', 1777556981319
  WHERE NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations
      WHERE hash = '52f8bb4fa4159440cfcb8e8d07fc0f870b8f7f2d4ac3125cb68065377bd50c45'
  );

ALTER TABLE "connections" ADD COLUMN IF NOT EXISTS "table_access" jsonb DEFAULT '{"default":"deny","tables":{}}'::jsonb NOT NULL;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
  SELECT '73df8744e0a3c86a4c32b4b20c50b67c56cc22bc775ce4bac8e92790e9ba6d0f', 1777560625125
  WHERE NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations
      WHERE hash = '73df8744e0a3c86a4c32b4b20c50b67c56cc22bc775ce4bac8e92790e9ba6d0f'
  );
