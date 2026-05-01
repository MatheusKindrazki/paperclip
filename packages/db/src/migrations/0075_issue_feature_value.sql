ALTER TABLE "issues" ADD COLUMN "feature_value" text;
ALTER TABLE "issues" ADD COLUMN "feature_value_set_at" timestamp with time zone;
ALTER TABLE "issues" ADD COLUMN "feature_value_set_by" uuid;

ALTER TABLE "issues" ADD CONSTRAINT "issues_feature_value_set_by_agents_id_fk" FOREIGN KEY ("feature_value_set_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "issues_feature_value_idx" ON "issues" USING btree ("company_id","feature_value");
CREATE INDEX "cost_events_company_issue_idx" ON "cost_events" USING btree ("company_id","issue_id");
