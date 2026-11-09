CREATE TABLE "goal_outcome_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"health" text NOT NULL,
	"evidence" text NOT NULL,
	"forecast_value" double precision,
	"uncertainty" text NOT NULL,
	"corrective_issue_id" uuid,
	"next_review_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_outcome_checkins_health_check" CHECK ("goal_outcome_checkins"."health" in ('on_track', 'at_risk', 'off_track', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "goal_outcome_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_revision" text NOT NULL,
	"source_key" text NOT NULL,
	"value" double precision NOT NULL,
	"unit" text NOT NULL,
	"population" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid" text DEFAULT 'true' NOT NULL,
	"submitted_by" text NOT NULL,
	"submitter_type" text NOT NULL,
	"submitter_source" text NOT NULL,
	"submitter_key_id" uuid,
	"run_id" uuid,
	"guardrail_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supersedes_id" uuid,
	"correction_reason" text,
	CONSTRAINT "goal_outcome_observations_target_owner_uq" UNIQUE("company_id","goal_id","target_id","id"),
	CONSTRAINT "goal_outcome_observations_source_key_uq" UNIQUE("target_id","source","source_key"),
	CONSTRAINT "goal_outcome_observations_window_check" CHECK ("goal_outcome_observations"."window_end" > "goal_outcome_observations"."window_start"),
	CONSTRAINT "goal_outcome_observations_availability_check" CHECK ("goal_outcome_observations"."available_at" >= "goal_outcome_observations"."observed_at"),
	CONSTRAINT "goal_outcome_observations_correction_reason_check" CHECK ("goal_outcome_observations"."supersedes_id" is null or ("goal_outcome_observations"."correction_reason" is not null and length(trim("goal_outcome_observations"."correction_reason")) > 0)),
	CONSTRAINT "goal_outcome_observations_valid_check" CHECK ("goal_outcome_observations"."valid" in ('true', 'false')),
	CONSTRAINT "goal_outcome_observations_submitter_type_check" CHECK ("goal_outcome_observations"."submitter_type" in ('agent', 'user'))
);
--> statement-breakpoint
CREATE TABLE "goal_outcome_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"label" text NOT NULL,
	"timezone" text NOT NULL,
	"interval_start" timestamp with time zone NOT NULL,
	"interval_end" timestamp with time zone NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_outcome_periods_goal_company_id_uq" UNIQUE("company_id","goal_id","id"),
	CONSTRAINT "goal_outcome_periods_interval_check" CHECK ("goal_outcome_periods"."interval_end" > "goal_outcome_periods"."interval_start"),
	CONSTRAINT "goal_outcome_periods_lifecycle_check" CHECK ("goal_outcome_periods"."lifecycle" in ('draft', 'active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "goal_outcome_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"direction" text NOT NULL,
	"aggregation" text NOT NULL,
	"population" text NOT NULL,
	"source" text NOT NULL,
	"query_version" text NOT NULL,
	"freshness_hours" integer NOT NULL,
	"maturity_hours" integer DEFAULT 24 NOT NULL,
	"baseline_value" double precision,
	"target_value" double precision,
	"range_min" double precision,
	"range_max" double precision,
	"owner_agent_id" uuid,
	"guardrails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trajectory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_outcome_targets_target_owner_uq" UNIQUE("company_id","goal_id","id"),
	CONSTRAINT "goal_outcome_targets_metric_revision_uq" UNIQUE("goal_id","metric_key","revision"),
	CONSTRAINT "goal_outcome_targets_revision_check" CHECK ("goal_outcome_targets"."revision" > 0),
	CONSTRAINT "goal_outcome_targets_kind_check" CHECK ("goal_outcome_targets"."kind" in ('number', 'percentage', 'currency', 'duration', 'count')),
	CONSTRAINT "goal_outcome_targets_direction_check" CHECK ("goal_outcome_targets"."direction" in ('increase', 'decrease', 'range')),
	CONSTRAINT "goal_outcome_targets_aggregation_check" CHECK ("goal_outcome_targets"."aggregation" in ('latest', 'sum')),
	CONSTRAINT "goal_outcome_targets_freshness_check" CHECK ("goal_outcome_targets"."freshness_hours" > 0),
	CONSTRAINT "goal_outcome_targets_maturity_check" CHECK ("goal_outcome_targets"."maturity_hours" > 0),
	CONSTRAINT "goal_outcome_targets_range_check" CHECK ("goal_outcome_targets"."direction" <> 'range' or ("goal_outcome_targets"."range_min" is not null and "goal_outcome_targets"."range_max" is not null and "goal_outcome_targets"."range_min" <= "goal_outcome_targets"."range_max"))
);
--> statement-breakpoint
CREATE TABLE "governance_milestone_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_version" integer,
	"evidence_snapshot_hash" text,
	"reviewer_user_id" text,
	"reviewer_agent_id" uuid,
	"executor_agent_id" uuid,
	"executor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_milestone_decisions_outcome_check" CHECK ("governance_milestone_decisions"."outcome" in ('accept', 'reject', 'revoke', 'supersede')),
	CONSTRAINT "governance_milestone_decisions_snapshot_check" CHECK ("governance_milestone_decisions"."outcome" = 'supersede' or ("governance_milestone_decisions"."evidence_version" is not null and "governance_milestone_decisions"."evidence_snapshot_hash" is not null)),
	CONSTRAINT "governance_milestone_decisions_reviewer_check" CHECK ("governance_milestone_decisions"."reviewer_user_id" is not null or "governance_milestone_decisions"."reviewer_agent_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "governance_milestone_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_milestone_events_kind_check" CHECK ("governance_milestone_events"."kind" in ('milestone_accept', 'milestone_reject', 'milestone_revoke', 'milestone_supersede'))
);
--> statement-breakpoint
CREATE TABLE "governance_milestone_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"evidence_version" integer NOT NULL,
	"deliverable_key" text NOT NULL,
	"evidence_kind" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"artifact_revision" integer,
	"artifact_hash" text,
	"artifact_source_trust" jsonb DEFAULT 'null'::jsonb NOT NULL,
	"artifact_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_by_user_id" text,
	"submitted_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_milestone_evidence_version_check" CHECK ("governance_milestone_evidence"."evidence_version" > 0),
	CONSTRAINT "governance_milestone_evidence_evidence_kind_check" CHECK ("governance_milestone_evidence"."evidence_kind" in ('document_revision', 'work_product', 'issue_completion'))
);
--> statement-breakpoint
CREATE TABLE "governance_milestone_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"accepted_revision_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_milestone_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"milestone_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"contract" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"promoted_by_user_id" text,
	"promoted_at" timestamp with time zone,
	"promotion_proof" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_milestone_revisions_revision_check" CHECK ("governance_milestone_revisions"."revision" > 0),
	CONSTRAINT "governance_milestone_revisions_state_check" CHECK ("governance_milestone_revisions"."state" in ('draft', 'active', 'accepted', 'rejected', 'revoked', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "governance_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_operation_exception_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"task_issue_id" uuid NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_operation_exception_escalations_generation_check" CHECK ("governance_operation_exception_escalations"."generation" = 1)
);
--> statement-breakpoint
CREATE TABLE "governance_operation_exception_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text,
	"reason" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_operation_exception_events_kind_check" CHECK ("governance_operation_exception_events"."kind" in ('received', 'admitted', 'paused', 'resumed', 'resolved', 'escalated', 'escalation_blocked'))
);
--> statement-breakpoint
CREATE TABLE "governance_operation_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"clock_paused_at" timestamp with time zone,
	"clock_paused_total_ms" bigint DEFAULT 0 NOT NULL,
	"pause_reason" text,
	"last_resumed_at" timestamp with time zone,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"escalation_generation" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalation_retry_at" timestamp with time zone,
	"escalation_block_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_operation_exceptions_state_check" CHECK ("governance_operation_exceptions"."state" in ('open', 'resolved')),
	CONSTRAINT "governance_operation_exceptions_revision_check" CHECK ("governance_operation_exceptions"."revision" >= 1),
	CONSTRAINT "governance_operation_exceptions_generation_check" CHECK ("governance_operation_exceptions"."escalation_generation" between 0 and 1),
	CONSTRAINT "governance_operation_exceptions_deadline_check" CHECK ("governance_operation_exceptions"."deadline_at" > "governance_operation_exceptions"."admitted_at"),
	CONSTRAINT "governance_operation_exceptions_pause_check" CHECK (("governance_operation_exceptions"."clock_paused_at" is null) = ("governance_operation_exceptions"."pause_reason" is null)),
	CONSTRAINT "governance_operation_exceptions_paused_duration_check" CHECK ("governance_operation_exceptions"."clock_paused_total_ms" >= 0),
	CONSTRAINT "governance_operation_exceptions_resolution_check" CHECK (("governance_operation_exceptions"."state" = 'open' and "governance_operation_exceptions"."resolved_at" is null) or ("governance_operation_exceptions"."state" = 'resolved' and "governance_operation_exceptions"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "issue_planning" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"earliest_start" text,
	"planned_start" text,
	"planned_finish" text,
	"hard_deadline" text,
	"forecast_start" text,
	"forecast_finish" text,
	"actual_start" text,
	"actual_finish" text,
	"date_mode" text DEFAULT 'timed' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_planning_date_mode_check" CHECK ("issue_planning"."date_mode" in ('timed', 'all_day')),
	CONSTRAINT "issue_planning_revision_check" CHECK ("issue_planning"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "routine_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"revision_id" uuid,
	"revision_number" integer NOT NULL,
	"occurrence_key" text NOT NULL,
	"disposition" text DEFAULT 'obligation' NOT NULL,
	"execution_state" text DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"owner_user_id" text,
	"task_id" uuid,
	"run_id" uuid,
	"approved_workflow_document_id" uuid,
	"approved_workflow_revision_id" uuid,
	"milestone_id" uuid,
	"milestone_revision_id" uuid,
	"case_id" uuid,
	"case_handoff_version" integer,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"wake_requested_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_task_status_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_occurrences_disposition_check" CHECK ("routine_occurrences"."disposition" in ('obligation', 'satisfied', 'skipped', 'waived', 'suppressed')),
	CONSTRAINT "routine_occurrences_decision_reason_check" CHECK ("routine_occurrences"."disposition" not in ('skipped', 'waived', 'suppressed') or ("routine_occurrences"."decision_reason" is not null and length(trim("routine_occurrences"."decision_reason")) > 0)),
	CONSTRAINT "routine_occurrences_satisfied_check" CHECK ("routine_occurrences"."disposition" <> 'satisfied' or "routine_occurrences"."execution_state" = 'satisfied'),
	CONSTRAINT "routine_occurrences_execution_state_check" CHECK ("routine_occurrences"."execution_state" in ('pending', 'dispatching', 'waiting', 'satisfied', 'failed', 'cancelled', 'unknown', 'skipped')),
	CONSTRAINT "routine_occurrences_approved_workflow_binding_check" CHECK (("routine_occurrences"."approved_workflow_document_id" is null and "routine_occurrences"."approved_workflow_revision_id" is null) or ("routine_occurrences"."approved_workflow_document_id" is not null and "routine_occurrences"."approved_workflow_revision_id" is not null)),
	CONSTRAINT "routine_occurrences_milestone_binding_check" CHECK (("routine_occurrences"."milestone_id" is null and "routine_occurrences"."milestone_revision_id" is null) or ("routine_occurrences"."milestone_id" is not null and "routine_occurrences"."milestone_revision_id" is not null and "routine_occurrences"."case_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD COLUMN "dispatch_actor" jsonb;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "catch_up_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "catch_up_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "catch_up_executions_consumed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD COLUMN "catch_up_latest_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "approved_workflow_document_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "approved_workflow_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "milestone_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "case_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestones_company_id_uq" ON "governance_milestones" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestone_revisions_company_id_uq" ON "governance_milestone_revisions" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestone_decisions_company_id_uq" ON "governance_milestone_decisions" USING btree ("company_id","id");--> statement-breakpoint
ALTER TABLE "goal_outcome_checkins" ADD CONSTRAINT "goal_outcome_checkins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_checkins" ADD CONSTRAINT "goal_outcome_checkins_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_checkins" ADD CONSTRAINT "goal_outcome_checkins_target_owner_fk" FOREIGN KEY ("company_id","goal_id","target_id") REFERENCES "public"."goal_outcome_targets"("company_id","goal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_checkins" ADD CONSTRAINT "goal_outcome_checkins_corrective_issue_company_fk" FOREIGN KEY ("company_id","corrective_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_observations" ADD CONSTRAINT "goal_outcome_observations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_observations" ADD CONSTRAINT "goal_outcome_observations_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_observations" ADD CONSTRAINT "goal_outcome_observations_target_owner_fk" FOREIGN KEY ("company_id","goal_id","target_id") REFERENCES "public"."goal_outcome_targets"("company_id","goal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_observations" ADD CONSTRAINT "goal_outcome_observations_supersedes_owner_fk" FOREIGN KEY ("company_id","goal_id","target_id","supersedes_id") REFERENCES "public"."goal_outcome_observations"("company_id","goal_id","target_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_periods" ADD CONSTRAINT "goal_outcome_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_periods" ADD CONSTRAINT "goal_outcome_periods_goal_company_fk" FOREIGN KEY ("company_id","goal_id") REFERENCES "public"."goals"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_targets" ADD CONSTRAINT "goal_outcome_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_targets" ADD CONSTRAINT "goal_outcome_targets_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_targets" ADD CONSTRAINT "goal_outcome_targets_period_owner_fk" FOREIGN KEY ("company_id","goal_id","period_id") REFERENCES "public"."goal_outcome_periods"("company_id","goal_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_outcome_targets" ADD CONSTRAINT "goal_outcome_targets_owner_company_fk" FOREIGN KEY ("company_id","owner_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_milestone_id_governance_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."governance_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_revision_id_governance_milestone_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."governance_milestone_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_executor_agent_id_agents_id_fk" FOREIGN KEY ("executor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_company_milestone_fk" FOREIGN KEY ("company_id","milestone_id") REFERENCES "public"."governance_milestones"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_decisions" ADD CONSTRAINT "governance_milestone_decisions_company_revision_fk" FOREIGN KEY ("company_id","revision_id") REFERENCES "public"."governance_milestone_revisions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_milestone_id_governance_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."governance_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_revision_id_governance_milestone_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."governance_milestone_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_decision_id_governance_milestone_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."governance_milestone_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_company_milestone_fk" FOREIGN KEY ("company_id","milestone_id") REFERENCES "public"."governance_milestones"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_company_revision_fk" FOREIGN KEY ("company_id","revision_id") REFERENCES "public"."governance_milestone_revisions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_events" ADD CONSTRAINT "governance_milestone_events_company_decision_fk" FOREIGN KEY ("company_id","decision_id") REFERENCES "public"."governance_milestone_decisions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_evidence" ADD CONSTRAINT "governance_milestone_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_evidence" ADD CONSTRAINT "governance_milestone_evidence_milestone_id_governance_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."governance_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_evidence" ADD CONSTRAINT "governance_milestone_evidence_revision_id_governance_milestone_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."governance_milestone_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_evidence" ADD CONSTRAINT "governance_milestone_evidence_submitted_by_agent_id_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_evidence" ADD CONSTRAINT "governance_milestone_evidence_company_milestone_fk" FOREIGN KEY ("company_id","milestone_id") REFERENCES "public"."governance_milestones"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_evidence" ADD CONSTRAINT "governance_milestone_evidence_company_revision_fk" FOREIGN KEY ("company_id","revision_id") REFERENCES "public"."governance_milestone_revisions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_followups" ADD CONSTRAINT "governance_milestone_followups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_followups" ADD CONSTRAINT "governance_milestone_followups_milestone_id_governance_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."governance_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_followups" ADD CONSTRAINT "governance_milestone_followups_accepted_revision_id_governance_milestone_revisions_id_fk" FOREIGN KEY ("accepted_revision_id") REFERENCES "public"."governance_milestone_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_followups" ADD CONSTRAINT "governance_milestone_followups_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_followups" ADD CONSTRAINT "governance_milestone_followups_company_milestone_fk" FOREIGN KEY ("company_id","milestone_id") REFERENCES "public"."governance_milestones"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_followups" ADD CONSTRAINT "governance_milestone_followups_company_revision_fk" FOREIGN KEY ("company_id","accepted_revision_id") REFERENCES "public"."governance_milestone_revisions"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_revisions" ADD CONSTRAINT "governance_milestone_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_revisions" ADD CONSTRAINT "governance_milestone_revisions_milestone_id_governance_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."governance_milestones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_revisions" ADD CONSTRAINT "governance_milestone_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestone_revisions" ADD CONSTRAINT "governance_milestone_revisions_company_milestone_fk" FOREIGN KEY ("company_id","milestone_id") REFERENCES "public"."governance_milestones"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestones" ADD CONSTRAINT "governance_milestones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestones" ADD CONSTRAINT "governance_milestones_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestones" ADD CONSTRAINT "governance_milestones_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_milestones" ADD CONSTRAINT "governance_milestones_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exception_escalations" ADD CONSTRAINT "governance_operation_exception_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exception_escalations" ADD CONSTRAINT "governance_operation_exception_escalations_exception_id_governance_operation_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."governance_operation_exceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exception_escalations" ADD CONSTRAINT "governance_operation_exception_escalations_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exception_events" ADD CONSTRAINT "governance_operation_exception_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exception_events" ADD CONSTRAINT "governance_operation_exception_events_exception_id_governance_operation_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."governance_operation_exceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exceptions" ADD CONSTRAINT "governance_operation_exceptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exceptions" ADD CONSTRAINT "governance_operation_exceptions_occurrence_id_routine_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."routine_occurrences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_operation_exceptions" ADD CONSTRAINT "governance_operation_exceptions_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_planning" ADD CONSTRAINT "issue_planning_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_planning" ADD CONSTRAINT "issue_planning_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_revision_id_routine_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_run_id_routine_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_approved_workflow_document_id_documents_id_fk" FOREIGN KEY ("approved_workflow_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_approved_workflow_revision_id_document_revisions_id_fk" FOREIGN KEY ("approved_workflow_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_milestone_revision_id_governance_milestone_revisions_id_fk" FOREIGN KEY ("milestone_revision_id") REFERENCES "public"."governance_milestone_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_outcome_checkins_goal_idx" ON "goal_outcome_checkins" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_outcome_observations_correction_uq" ON "goal_outcome_observations" USING btree ("supersedes_id") WHERE "goal_outcome_observations"."supersedes_id" is not null;--> statement-breakpoint
CREATE INDEX "goal_outcome_observations_target_observed_idx" ON "goal_outcome_observations" USING btree ("target_id","observed_at");--> statement-breakpoint
CREATE INDEX "goal_outcome_periods_goal_idx" ON "goal_outcome_periods" USING btree ("goal_id","interval_start");--> statement-breakpoint
CREATE INDEX "goal_outcome_targets_period_idx" ON "goal_outcome_targets" USING btree ("period_id","metric_key","revision");--> statement-breakpoint
CREATE INDEX "governance_milestone_decisions_created_idx" ON "governance_milestone_decisions" USING btree ("milestone_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestone_events_decision_uq" ON "governance_milestone_events" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "governance_milestone_events_delivery_idx" ON "governance_milestone_events" USING btree ("acknowledged_at","created_at");--> statement-breakpoint
CREATE INDEX "governance_milestone_evidence_revision_key_idx" ON "governance_milestone_evidence" USING btree ("revision_id","deliverable_key","evidence_version");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestone_evidence_version_uq" ON "governance_milestone_evidence" USING btree ("revision_id","evidence_version");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestone_followup_logical_uq" ON "governance_milestone_followups" USING btree ("company_id","milestone_id","accepted_revision_id","action_key");--> statement-breakpoint
CREATE INDEX "governance_milestone_followups_issue_idx" ON "governance_milestone_followups" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestone_revision_uq" ON "governance_milestone_revisions" USING btree ("milestone_id","revision");--> statement-breakpoint
CREATE INDEX "governance_milestone_revision_state_idx" ON "governance_milestone_revisions" USING btree ("milestone_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_milestones_case_uq" ON "governance_milestones" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "governance_milestones_company_case_idx" ON "governance_milestones" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_operation_exception_escalations_generation_uq" ON "governance_operation_exception_escalations" USING btree ("exception_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_operation_exception_escalations_task_uq" ON "governance_operation_exception_escalations" USING btree ("task_issue_id");--> statement-breakpoint
CREATE INDEX "governance_operation_exception_escalations_company_exception_idx" ON "governance_operation_exception_escalations" USING btree ("company_id","exception_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_operation_exception_events_key_uq" ON "governance_operation_exception_events" USING btree ("company_id","exception_id","event_key");--> statement-breakpoint
CREATE INDEX "governance_operation_exception_events_history_idx" ON "governance_operation_exception_events" USING btree ("exception_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "governance_operation_exceptions_occurrence_uq" ON "governance_operation_exceptions" USING btree ("company_id","occurrence_id");--> statement-breakpoint
CREATE INDEX "governance_operation_exceptions_due_idx" ON "governance_operation_exceptions" USING btree ("company_id","state","deadline_at");--> statement-breakpoint
CREATE INDEX "issue_planning_company_start_idx" ON "issue_planning" USING btree ("company_id","planned_start");--> statement-breakpoint
CREATE INDEX "issue_planning_company_deadline_idx" ON "issue_planning" USING btree ("company_id","hard_deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "routine_occurrences_identity_uq" ON "routine_occurrences" USING btree ("company_id","routine_id","trigger_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "routine_occurrences_dispatch_idx" ON "routine_occurrences" USING btree ("execution_state","retry_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "routine_occurrences_history_idx" ON "routine_occurrences" USING btree ("company_id","routine_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "routine_occurrences_task_idx" ON "routine_occurrences" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "routine_occurrences_case_idx" ON "routine_occurrences" USING btree ("company_id","case_id");--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_catch_up_revision_id_routine_revisions_id_fk" FOREIGN KEY ("catch_up_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_approved_workflow_document_id_documents_id_fk" FOREIGN KEY ("approved_workflow_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_approved_workflow_revision_id_document_revisions_id_fk" FOREIGN KEY ("approved_workflow_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_milestone_revision_id_governance_milestone_revisions_id_fk" FOREIGN KEY ("milestone_revision_id") REFERENCES "public"."governance_milestone_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_triggers" ADD CONSTRAINT "routine_triggers_catch_up_episode_check" CHECK (("routine_triggers"."catch_up_cutoff" IS NULL AND "routine_triggers"."catch_up_revision_id" IS NULL AND "routine_triggers"."catch_up_executions_consumed" = 0 AND NOT "routine_triggers"."catch_up_latest_only") OR ("routine_triggers"."catch_up_cutoff" IS NOT NULL AND "routine_triggers"."catch_up_revision_id" IS NOT NULL AND "routine_triggers"."catch_up_executions_consumed" BETWEEN 0 AND 25));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_approved_workflow_binding_check" CHECK (("routines"."approved_workflow_document_id" is null and "routines"."approved_workflow_revision_id" is null) or ("routines"."approved_workflow_document_id" is not null and "routines"."approved_workflow_revision_id" is not null));--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_milestone_binding_check" CHECK (("routines"."milestone_id" is null and "routines"."milestone_revision_id" is null) or ("routines"."milestone_id" is not null and "routines"."milestone_revision_id" is not null and "routines"."case_id" is not null));
--> statement-breakpoint
CREATE FUNCTION reject_goal_outcome_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'goal outcome history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER goal_outcome_targets_immutable BEFORE UPDATE ON goal_outcome_targets FOR EACH ROW EXECUTE FUNCTION reject_goal_outcome_update();
--> statement-breakpoint
CREATE TRIGGER goal_outcome_observations_immutable BEFORE UPDATE ON goal_outcome_observations FOR EACH ROW EXECUTE FUNCTION reject_goal_outcome_update();
--> statement-breakpoint
CREATE TRIGGER goal_outcome_checkins_immutable BEFORE UPDATE ON goal_outcome_checkins FOR EACH ROW EXECUTE FUNCTION reject_goal_outcome_update();
--> statement-breakpoint
CREATE TRIGGER goal_outcome_periods_immutable BEFORE UPDATE ON goal_outcome_periods FOR EACH ROW EXECUTE FUNCTION reject_goal_outcome_update();