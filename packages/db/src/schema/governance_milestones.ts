import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { cases } from "./cases.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const governanceMilestones = pgTable("governance_milestones", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
  createdByUserId: text("created_by_user_id"),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  caseUq: uniqueIndex("governance_milestones_case_uq").on(table.caseId),
  companyIdUq: uniqueIndex("governance_milestones_company_id_uq").on(table.companyId, table.id),
  companyCaseIdx: index("governance_milestones_company_case_idx").on(table.companyId, table.caseId),
}));

export const governanceMilestoneRevisions = pgTable("governance_milestone_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").notNull().references(() => governanceMilestones.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  contract: jsonb("contract").$type<Record<string, unknown>>().notNull(),
  state: text("state").notNull().default("draft"),
  createdByUserId: text("created_by_user_id"),
  createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  promotedByUserId: text("promoted_by_user_id"),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotionProof: jsonb("promotion_proof").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  milestoneRevisionUq: uniqueIndex("governance_milestone_revision_uq").on(table.milestoneId, table.revision),
  companyIdUq: uniqueIndex("governance_milestone_revisions_company_id_uq").on(table.companyId, table.id),
  milestoneStateIdx: index("governance_milestone_revision_state_idx").on(table.milestoneId, table.state),
  milestoneCompanyFk: foreignKey({ columns: [table.companyId, table.milestoneId], foreignColumns: [governanceMilestones.companyId, governanceMilestones.id], name: "governance_milestone_revisions_company_milestone_fk" }).onDelete("cascade"),
  revisionCheck: check("governance_milestone_revisions_revision_check", sql`${table.revision} > 0`),
  stateCheck: check("governance_milestone_revisions_state_check", sql`${table.state} in ('draft', 'active', 'accepted', 'rejected', 'revoked', 'superseded')`),
}));

export const governanceMilestoneEvidence = pgTable("governance_milestone_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").notNull().references(() => governanceMilestones.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => governanceMilestoneRevisions.id, { onDelete: "cascade" }),
  evidenceVersion: integer("evidence_version").notNull(),
  deliverableKey: text("deliverable_key").notNull(),
  evidenceKind: text("evidence_kind").notNull(),
  artifactId: uuid("artifact_id").notNull(),
  artifactRevision: integer("artifact_revision"),
  artifactHash: text("artifact_hash"),
  artifactSourceTrust: jsonb("artifact_source_trust").$type<Record<string, unknown> | null>().notNull().default(sql`'null'::jsonb`),
  artifactProvenance: jsonb("artifact_provenance").$type<Record<string, unknown>>().notNull().default({}),
  submittedByUserId: text("submitted_by_user_id"),
  submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  revisionKeyIdx: index("governance_milestone_evidence_revision_key_idx").on(table.revisionId, table.deliverableKey, table.evidenceVersion),
  milestoneCompanyFk: foreignKey({ columns: [table.companyId, table.milestoneId], foreignColumns: [governanceMilestones.companyId, governanceMilestones.id], name: "governance_milestone_evidence_company_milestone_fk" }).onDelete("cascade"),
  revisionCompanyFk: foreignKey({ columns: [table.companyId, table.revisionId], foreignColumns: [governanceMilestoneRevisions.companyId, governanceMilestoneRevisions.id], name: "governance_milestone_evidence_company_revision_fk" }).onDelete("cascade"),
  evidenceVersionUq: uniqueIndex("governance_milestone_evidence_version_uq").on(table.revisionId, table.evidenceVersion),
  evidenceVersionCheck: check("governance_milestone_evidence_version_check", sql`${table.evidenceVersion} > 0`),
  evidenceKindCheck: check("governance_milestone_evidence_evidence_kind_check", sql`${table.evidenceKind} in ('document_revision', 'work_product', 'issue_completion')`),
}));

export const governanceMilestoneDecisions = pgTable("governance_milestone_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").notNull().references(() => governanceMilestones.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => governanceMilestoneRevisions.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  reason: text("reason").notNull(),
  evidenceVersion: integer("evidence_version"),
  evidenceSnapshotHash: text("evidence_snapshot_hash"),
  reviewerUserId: text("reviewer_user_id"),
  reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
  executorAgentId: uuid("executor_agent_id").references(() => agents.id, { onDelete: "set null" }),
  executorUserId: text("executor_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  milestoneCreatedIdx: index("governance_milestone_decisions_created_idx").on(table.milestoneId, table.createdAt),
  companyIdUq: uniqueIndex("governance_milestone_decisions_company_id_uq").on(table.companyId, table.id),
  milestoneCompanyFk: foreignKey({ columns: [table.companyId, table.milestoneId], foreignColumns: [governanceMilestones.companyId, governanceMilestones.id], name: "governance_milestone_decisions_company_milestone_fk" }).onDelete("cascade"),
  revisionCompanyFk: foreignKey({ columns: [table.companyId, table.revisionId], foreignColumns: [governanceMilestoneRevisions.companyId, governanceMilestoneRevisions.id], name: "governance_milestone_decisions_company_revision_fk" }).onDelete("cascade"),
  outcomeCheck: check("governance_milestone_decisions_outcome_check", sql`${table.outcome} in ('accept', 'reject', 'revoke', 'supersede')`),
  snapshotCheck: check("governance_milestone_decisions_snapshot_check", sql`${table.outcome} = 'supersede' or (${table.evidenceVersion} is not null and ${table.evidenceSnapshotHash} is not null)`),
  reviewerCheck: check("governance_milestone_decisions_reviewer_check", sql`${table.reviewerUserId} is not null or ${table.reviewerAgentId} is not null`),
}));

export const governanceMilestoneEvents = pgTable("governance_milestone_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").notNull().references(() => governanceMilestones.id, { onDelete: "cascade" }),
  revisionId: uuid("revision_id").notNull().references(() => governanceMilestoneRevisions.id, { onDelete: "cascade" }),
  decisionId: uuid("decision_id").notNull().references(() => governanceMilestoneDecisions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  decisionUq: uniqueIndex("governance_milestone_events_decision_uq").on(table.decisionId),
  milestoneCompanyFk: foreignKey({ columns: [table.companyId, table.milestoneId], foreignColumns: [governanceMilestones.companyId, governanceMilestones.id], name: "governance_milestone_events_company_milestone_fk" }).onDelete("cascade"),
  revisionCompanyFk: foreignKey({ columns: [table.companyId, table.revisionId], foreignColumns: [governanceMilestoneRevisions.companyId, governanceMilestoneRevisions.id], name: "governance_milestone_events_company_revision_fk" }).onDelete("cascade"),
  decisionCompanyFk: foreignKey({ columns: [table.companyId, table.decisionId], foreignColumns: [governanceMilestoneDecisions.companyId, governanceMilestoneDecisions.id], name: "governance_milestone_events_company_decision_fk" }).onDelete("cascade"),
  deliveryIdx: index("governance_milestone_events_delivery_idx").on(table.acknowledgedAt, table.createdAt),
  eventKindCheck: check("governance_milestone_events_kind_check", sql`${table.kind} in ('milestone_accept', 'milestone_reject', 'milestone_revoke', 'milestone_supersede')`),
}));

export const governanceMilestoneFollowups = pgTable("governance_milestone_followups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  milestoneId: uuid("milestone_id").notNull().references(() => governanceMilestones.id, { onDelete: "cascade" }),
  acceptedRevisionId: uuid("accepted_revision_id").notNull().references(() => governanceMilestoneRevisions.id, { onDelete: "restrict" }),
  actionKey: text("action_key").notNull(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  logicalActionUq: uniqueIndex("governance_milestone_followup_logical_uq").on(table.companyId, table.milestoneId, table.acceptedRevisionId, table.actionKey),
  milestoneCompanyFk: foreignKey({ columns: [table.companyId, table.milestoneId], foreignColumns: [governanceMilestones.companyId, governanceMilestones.id], name: "governance_milestone_followups_company_milestone_fk" }).onDelete("cascade"),
  revisionCompanyFk: foreignKey({ columns: [table.companyId, table.acceptedRevisionId], foreignColumns: [governanceMilestoneRevisions.companyId, governanceMilestoneRevisions.id], name: "governance_milestone_followups_company_revision_fk" }).onDelete("restrict"),
  issueIdx: index("governance_milestone_followups_issue_idx").on(table.issueId),
}));
