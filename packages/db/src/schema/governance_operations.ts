import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { routineOccurrences } from "./routines.js";

export const governanceOperationExceptions = pgTable("governance_operation_exceptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  occurrenceId: uuid("occurrence_id").notNull().references(() => routineOccurrences.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => authUsers.id, { onDelete: "restrict" }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  admittedAt: timestamp("admitted_at", { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  clockPausedAt: timestamp("clock_paused_at", { withTimezone: true }),
  clockPausedTotalMs: bigint("clock_paused_total_ms", { mode: "number" }).notNull().default(0),
  pauseReason: text("pause_reason"),
  lastResumedAt: timestamp("last_resumed_at", { withTimezone: true }),
  state: text("state").notNull().default("open"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  escalationGeneration: integer("escalation_generation").notNull().default(0),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
  escalationRetryAt: timestamp("escalation_retry_at", { withTimezone: true }),
  escalationBlockReason: text("escalation_block_reason"),
  revision: integer("revision").notNull().default(1),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  occurrenceUq: uniqueIndex("governance_operation_exceptions_occurrence_uq").on(table.companyId, table.occurrenceId),
  dueIdx: index("governance_operation_exceptions_due_idx").on(table.companyId, table.state, table.deadlineAt),
  stateCheck: check("governance_operation_exceptions_state_check", sql`${table.state} in ('open', 'resolved')`),
  revisionCheck: check("governance_operation_exceptions_revision_check", sql`${table.revision} >= 1`),
  generationCheck: check("governance_operation_exceptions_generation_check", sql`${table.escalationGeneration} between 0 and 1`),
  deadlineCheck: check("governance_operation_exceptions_deadline_check", sql`${table.deadlineAt} > ${table.admittedAt}`),
  pauseCheck: check("governance_operation_exceptions_pause_check", sql`(${table.clockPausedAt} is null) = (${table.pauseReason} is null)`),
  pausedDurationCheck: check("governance_operation_exceptions_paused_duration_check", sql`${table.clockPausedTotalMs} >= 0`),
  resolutionCheck: check("governance_operation_exceptions_resolution_check", sql`(${table.state} = 'open' and ${table.resolvedAt} is null) or (${table.state} = 'resolved' and ${table.resolvedAt} is not null)`),
}));

export const governanceOperationExceptionEvents = pgTable("governance_operation_exception_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  exceptionId: uuid("exception_id").notNull().references(() => governanceOperationExceptions.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  kind: text("kind").notNull(),
  actorUserId: text("actor_user_id"),
  reason: text("reason"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  eventKeyUq: uniqueIndex("governance_operation_exception_events_key_uq").on(table.companyId, table.exceptionId, table.eventKey),
  eventHistoryIdx: index("governance_operation_exception_events_history_idx").on(table.exceptionId, table.createdAt),
  kindCheck: check("governance_operation_exception_events_kind_check", sql`${table.kind} in ('received', 'admitted', 'paused', 'resumed', 'resolved', 'escalated', 'escalation_blocked')`),
}));

export const governanceOperationExceptionEscalations = pgTable("governance_operation_exception_escalations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  exceptionId: uuid("exception_id").notNull().references(() => governanceOperationExceptions.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull(),
  taskIssueId: uuid("task_issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  generationUq: uniqueIndex("governance_operation_exception_escalations_generation_uq").on(table.exceptionId, table.generation),
  taskUq: uniqueIndex("governance_operation_exception_escalations_task_uq").on(table.taskIssueId),
  companyExceptionIdx: index("governance_operation_exception_escalations_company_exception_idx").on(table.companyId, table.exceptionId),
  generationCheck: check("governance_operation_exception_escalations_generation_check", sql`${table.generation} = 1`),
}));
