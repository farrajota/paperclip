WITH candidates AS (
  SELECT
    r."id",
    r."company_id",
    CASE
      WHEN c."default_responsible_user_id" IS NOT NULL THEN
        CASE WHEN default_membership."id" IS NOT NULL THEN c."default_responsible_user_id" END
      ELSE oldest_owner."principal_id"
    END AS "resolved_user_id"
  FROM "routines" r
  JOIN "companies" c ON c."id" = r."company_id"
  JOIN "agents" a
    ON a."id" = r."assignee_agent_id"
    AND a."company_id" = r."company_id"
    AND a."status" <> 'terminated'
    AND a."metadata" -> 'paperclipBuiltInAgent' ->> 'key' = split_part(r."origin_id", ':', 1)
  LEFT JOIN "company_memberships" default_membership
    ON default_membership."company_id" = c."id"
    AND default_membership."principal_type" = 'user'
    AND default_membership."principal_id" = c."default_responsible_user_id"
    AND default_membership."status" = 'active'
  LEFT JOIN LATERAL (
    SELECT membership."principal_id"
    FROM "company_memberships" membership
    WHERE membership."company_id" = c."id"
      AND membership."principal_type" = 'user'
      AND membership."status" = 'active'
      AND membership."membership_role" = 'owner'
    ORDER BY membership."created_at", membership."id"
    LIMIT 1
  ) oldest_owner ON c."default_responsible_user_id" IS NULL
  WHERE r."origin_kind" = 'built_in_agent_bundle'
    AND r."origin_id" IN (
      'reflection-coach:recent-agent-reflection',
      'summarizer:refresh-stale-summaries'
    )
    AND r."responsible_user_id" = 'built-in-bundles'
), inserted_revisions AS (
  INSERT INTO "routine_revisions" (
    "company_id",
    "routine_id",
    "revision_number",
    "title",
    "description",
    "snapshot",
    "change_summary",
    "created_by_agent_id",
    "created_by_user_id",
    "created_by_run_id",
    "responsible_user_id",
    "created_at"
  )
  SELECT
    r."company_id",
    r."id",
    CASE WHEN r."latest_revision_id" IS NULL THEN 1 ELSE r."latest_revision_number" + 1 END,
    r."title",
    r."description",
    jsonb_build_object(
      'version', 1,
      'routine', jsonb_build_object(
        'id', r."id",
        'companyId', r."company_id",
        'projectId', r."project_id",
        'goalId', r."goal_id",
        'parentIssueId', r."parent_issue_id",
        'title', r."title",
        'description', r."description",
        'assigneeAgentId', r."assignee_agent_id",
        'priority', r."priority",
        'status', r."status",
        'concurrencyPolicy', r."concurrency_policy",
        'catchUpPolicy', r."catch_up_policy",
        'activityGatePolicy', r."activity_gate_policy",
        'activityGateScope', r."activity_gate_scope",
        'variables', coalesce(r."variables", '[]'::jsonb),
        'env', r."env",
        'responsibleUserId', candidates."resolved_user_id",
        'approvedWorkflowDocumentId', r."approved_workflow_document_id",
        'approvedWorkflowRevisionId', r."approved_workflow_revision_id",
        'milestoneId', r."milestone_id",
        'milestoneRevisionId', r."milestone_revision_id",
        'caseId', r."case_id"
      ),
      'triggers', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', t."id",
          'setupPending', t."setup_pending",
          'kind', t."kind",
          'label', t."label",
          'enabled', t."enabled",
          'cronExpression', t."cron_expression",
          'timezone', t."timezone",
          'publicId', t."public_id",
          'signingMode', t."signing_mode",
          'replayWindowSec', t."replay_window_sec"
        ) ORDER BY t."created_at", t."id")
        FROM "routine_triggers" t
        WHERE t."company_id" = r."company_id"
          AND t."routine_id" = r."id"
          AND NOT t."archived"
      ), '[]'::jsonb)
    ),
    'Repair built-in routine accountable owner',
    NULL,
    NULL,
    NULL,
    candidates."resolved_user_id",
    now()
  FROM candidates
  JOIN "routines" r ON r."id" = candidates."id"
  WHERE candidates."resolved_user_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "routine_revisions" prior
      WHERE prior."routine_id" = r."id"
        AND prior."revision_number" = CASE WHEN r."latest_revision_id" IS NULL THEN 1 ELSE r."latest_revision_number" + 1 END
    )
  RETURNING "id", "routine_id", "revision_number", "responsible_user_id", "created_at"
)
UPDATE "routines" r
SET "responsible_user_id" = revisions."responsible_user_id",
    "latest_revision_id" = revisions."id",
    "latest_revision_number" = revisions."revision_number"
FROM inserted_revisions revisions
WHERE r."id" = revisions."routine_id"
  AND r."responsible_user_id" = 'built-in-bundles';
