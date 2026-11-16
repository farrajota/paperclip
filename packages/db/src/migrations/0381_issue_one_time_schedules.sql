CREATE TABLE "issue_one_time_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "assignee_agent_id" uuid NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "time_zone" text NOT NULL,
  "cancelled_at" timestamp with time zone,
  "cancellation_reason" text,
  "wakeup_request_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_one_time_schedules_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "issue_one_time_schedules_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_one_time_schedules_company_issue_uq"
  ON "issue_one_time_schedules" USING btree ("company_id", "issue_id");
--> statement-breakpoint
CREATE INDEX "issue_one_time_schedules_due_idx"
  ON "issue_one_time_schedules" USING btree ("company_id", "due_at")
  WHERE "cancelled_at" IS NULL AND "wakeup_request_id" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_issue_one_time_schedule_on_issue_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalidation_reason text;
BEGIN
  IF NEW.assignee_agent_id IS DISTINCT FROM OLD.assignee_agent_id
    OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id THEN
    invalidation_reason := 'Issue assignee changed after scheduling';
  ELSIF NEW.hidden_at IS NOT NULL THEN
    invalidation_reason := 'Issue was hidden before the scheduled run';
  ELSIF NEW.status NOT IN ('backlog', 'todo', 'in_progress') THEN
    invalidation_reason := 'Issue is no longer eligible for a scheduled run';
  ELSE
    RETURN NEW;
  END IF;

  UPDATE issue_one_time_schedules AS schedule
  SET cancelled_at = COALESCE(schedule.cancelled_at, now()),
      cancellation_reason = COALESCE(schedule.cancellation_reason, invalidation_reason),
      updated_at = now()
  WHERE schedule.company_id = OLD.company_id
    AND schedule.issue_id = OLD.id
    AND schedule.cancelled_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM agent_wakeup_requests AS dispatch
      WHERE dispatch.company_id = schedule.company_id
        AND dispatch.requested_by_actor_type = 'system'
        AND dispatch.requested_by_actor_id = 'native-status-wake-dispatch:' || schedule.wakeup_request_id::text
    );

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "issues_invalidate_one_time_schedule_target"
AFTER UPDATE OF "assignee_agent_id", "assignee_user_id", "status", "hidden_at" ON "issues"
FOR EACH ROW
EXECUTE FUNCTION invalidate_issue_one_time_schedule_on_issue_change();
