-- Re-add FK constraints dropped as emergency workaround for MOKA-4917/MOKA-4919.
-- The server now validates run_id before insert and retries with NULL on FK failure,
-- so these constraints are safe to restore.

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_log_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id")
    ON DELETE no action ON UPDATE no action;
 END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_comments_created_by_run_id_heartbeat_runs_id_fk') THEN
  ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_created_by_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id")
    ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
