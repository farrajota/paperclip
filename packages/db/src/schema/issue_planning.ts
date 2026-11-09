import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issuePlanning = pgTable("issue_planning", {
  issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  earliestStart: text("earliest_start"),
  plannedStart: text("planned_start"),
  plannedFinish: text("planned_finish"),
  hardDeadline: text("hard_deadline"),
  forecastStart: text("forecast_start"),
  forecastFinish: text("forecast_finish"),
  actualStart: text("actual_start"),
  actualFinish: text("actual_finish"),
  dateMode: text("date_mode").notNull().default("timed"),
  timezone: text("timezone").notNull().default("UTC"),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  dateModeCheck: check("issue_planning_date_mode_check", sql`${table.dateMode} in ('timed', 'all_day')`),
  revisionCheck: check("issue_planning_revision_check", sql`${table.revision} >= 0`),
  companyStartIdx: index("issue_planning_company_start_idx").on(table.companyId, table.plannedStart),
  companyDeadlineIdx: index("issue_planning_company_deadline_idx").on(table.companyId, table.hardDeadline),
}));
