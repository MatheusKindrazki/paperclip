-- Re-add FK constraints dropped as emergency workaround for MOKA-4917/MOKA-4919.
-- The server now validates run_id before insert and retries with NULL on FK failure,
-- so these constraints are safe to restore.

-- Backfill orphaned run_id references before adding constraints
UPDATE "activity_log"
SET "run_id" = NULL
WHERE "run_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "heartbeat_runs" WHERE "id" = "activity_log"."run_id");

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id")
    ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

-- Backfill orphaned created_by_run_id references before adding constraint
UPDATE "issue_comments"
SET "created_by_run_id" = NULL
WHERE "created_by_run_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "heartbeat_runs" WHERE "id" = "issue_comments"."created_by_run_id");

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_created_by_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id")
    ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
