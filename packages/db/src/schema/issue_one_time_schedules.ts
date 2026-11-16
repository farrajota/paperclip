import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueOneTimeSchedules = pgTable(
  "issue_one_time_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    // This is the assignee-at-creation snapshot, not a live agent reference.
    assigneeAgentId: uuid("assignee_agent_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    timeZone: text("time_zone").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    // Keep the durable wake id even if wake receipts are later pruned; its presence prevents a second claim.
    wakeupRequestId: uuid("wakeup_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueUq: uniqueIndex("issue_one_time_schedules_company_issue_uq").on(
      table.companyId,
      table.issueId,
    ),
    dueIdx: index("issue_one_time_schedules_due_idx")
      .on(table.companyId, table.dueAt)
      .where(sql`${table.cancelledAt} is null and ${table.wakeupRequestId} is null`),
  }),
);
