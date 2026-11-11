import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { IssueOneTimeSchedule } from "@paperclipai/shared";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issueOneTimeSchedules,
  issues,
} from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  isIssueOneTimeScheduleEligibleStatus,
  normalizeIssueScheduleTime,
  resolveDueIssueOneTimeSchedule,
  resolveIssueOneTimeScheduleStatus,
  type NormalizedIssueScheduleTime,
} from "./issue-one-time-schedule.js";
type IssueOneTimeScheduleReadDb = Pick<Db, "select">;

const ISSUE_ONE_TIME_SCHEDULE_INVALIDATION_MESSAGES: Record<string, string> = {
  company_inactive: "Company was not active when the scheduled run became due",
  issue_deleted: "Issue no longer exists",
  assignee_changed: "Issue assignee changed before the scheduled run",
  issue_ineligible: "Issue was hidden, blocked, in review, or terminal when the scheduled run became due",
  agent_ineligible: "Scheduled assignee no longer belongs to the issue company",
};

export const ISSUE_ONE_TIME_SCHEDULE_WAKE_REASON = "issue_one_time_schedule_due";
const ONE_TIME_SCHEDULE_REQUESTED_BY = "native-status-committer";

export async function logIssueOneTimeScheduleUpdate(
  db: Db,
  schedule: { id: string; companyId: string; issueId: string },
) {
  // Publish only after the schedule/wake transaction commits. The event is an
  // invalidation signal; readers still derive state from native persisted rows.
  await logActivity(db, {
    companyId: schedule.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "issue.one_time_schedule_updated",
    entityType: "issue",
    entityId: schedule.issueId,
    details: { scheduleId: schedule.id },
  });
}

export function issueOneTimeScheduleService(db: Db) {
  async function get(companyId: string, issueId: string) {
    const [schedule] = await db
      .select()
      .from(issueOneTimeSchedules)
      .where(
        and(
          eq(issueOneTimeSchedules.companyId, companyId),
          eq(issueOneTimeSchedules.issueId, issueId),
        ),
      )
      .limit(1);
    return schedule ? readScheduleWith(db, schedule) : null;
  }

  async function create(input: {
    companyId: string;
    issueId: string;
    timestamp: string;
    timeZone: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    let normalized: NormalizedIssueScheduleTime;
    try {
      normalized = normalizeIssueScheduleTime(input.timestamp, input.timeZone, now);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Invalid scheduled time");
    }

    const schedule = await db.transaction(async (tx) => {
      const [issue] = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          hiddenAt: issues.hiddenAt,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .for("update");
      if (!issue) throw notFound("Issue not found");

      const [company] = await tx
        .select({ status: companies.status })
        .from(companies)
        .where(eq(companies.id, issue.companyId))
        .limit(1);
      if (company?.status !== "active") {
        throw conflict("Issue scheduling requires an active company");
      }
      if (
        !issue.assigneeAgentId ||
        issue.assigneeUserId !== null ||
        !isIssueOneTimeScheduleEligibleStatus(issue.status) ||
        issue.hiddenAt !== null
      ) {
        throw conflict("Schedule a visible backlog, todo, or in-progress issue assigned to an agent");
      }
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
        .limit(1);
      if (!agent) throw conflict("Issue assignee is not an agent in this company");

      const [existing] = await tx
        .select()
        .from(issueOneTimeSchedules)
        .where(
          and(
            eq(issueOneTimeSchedules.companyId, issue.companyId),
            eq(issueOneTimeSchedules.issueId, issue.id),
          ),
        )
        .for("update");

      if (existing) {
        const previous = await readScheduleWith(tx, existing);
        if (["scheduled", "queued", "waiting", "running"].includes(previous.status)) {
          throw conflict("This issue already has a pending one-time run schedule", {
            scheduleId: existing.id,
            status: previous.status,
          });
        }
        const [updated] = await tx
          .update(issueOneTimeSchedules)
          .set({
            id: randomUUID(),
            assigneeAgentId: issue.assigneeAgentId,
            dueAt: normalized.dueAt,
            timeZone: normalized.timeZone,
            cancelledAt: null,
            cancellationReason: null,
            wakeupRequestId: null,
            updatedAt: now,
          })
          .where(eq(issueOneTimeSchedules.id, existing.id))
          .returning();
        if (!updated) throw conflict("Schedule changed while it was being replaced");
        return updated;
      }

      const [created] = await tx
        .insert(issueOneTimeSchedules)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          assigneeAgentId: issue.assigneeAgentId,
          dueAt: normalized.dueAt,
          timeZone: normalized.timeZone,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return created;
    });

    await logIssueOneTimeScheduleUpdate(db, schedule);
    return readScheduleWith(db, schedule);
  }

  async function cancel(input: {
    companyId: string;
    issueId: string;
    scheduleId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const schedule = await db.transaction(async (tx) => {
      const [issue] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .for("update");
      if (!issue) throw notFound("Issue not found");

      const [current] = await tx
        .select()
        .from(issueOneTimeSchedules)
        .where(
          and(
            eq(issueOneTimeSchedules.id, input.scheduleId),
            eq(issueOneTimeSchedules.companyId, input.companyId),
            eq(issueOneTimeSchedules.issueId, input.issueId),
          ),
        )
        .for("update");
      if (!current) throw notFound("One-time schedule not found");
      if (current.cancelledAt) return current;
      if (current.wakeupRequestId) {
        throw conflict("The native wake has already been durably queued and cannot be cancelled here", {
          scheduleId: current.id,
          wakeupRequestId: current.wakeupRequestId,
        });
      }
      const [cancelled] = await tx
        .update(issueOneTimeSchedules)
        .set({
          cancelledAt: now,
          cancellationReason: "Cancelled by user",
          updatedAt: now,
        })
        .where(
          and(
            eq(issueOneTimeSchedules.id, current.id),
            isNull(issueOneTimeSchedules.cancelledAt),
            isNull(issueOneTimeSchedules.wakeupRequestId),
          ),
        )
        .returning();
      if (!cancelled) throw conflict("Schedule was claimed by the due tick before cancellation");
      return cancelled;
    });
    await logIssueOneTimeScheduleUpdate(db, schedule);
    return readScheduleWith(db, schedule);
  }

  async function tickDue(now: Date) {
    const candidates = await db
      .select({
        id: issueOneTimeSchedules.id,
        companyId: issueOneTimeSchedules.companyId,
        issueId: issueOneTimeSchedules.issueId,
      })
      .from(issueOneTimeSchedules)
      .where(
        and(
          lte(issueOneTimeSchedules.dueAt, now),
          isNull(issueOneTimeSchedules.cancelledAt),
          isNull(issueOneTimeSchedules.wakeupRequestId),
        ),
      )
      .orderBy(asc(issueOneTimeSchedules.dueAt), asc(issueOneTimeSchedules.id))
      .limit(50);

    let claimed = 0;
    let invalidated = 0;
    for (const candidate of candidates) {
      const outcome = await db.transaction(async (tx) => {
        const [issue] = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            hiddenAt: issues.hiddenAt,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
          })
          .from(issues)
          .where(and(eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId)))
          .for("update");
        const [schedule] = await tx
          .select()
          .from(issueOneTimeSchedules)
          .where(
            and(
              eq(issueOneTimeSchedules.id, candidate.id),
              eq(issueOneTimeSchedules.companyId, candidate.companyId),
              eq(issueOneTimeSchedules.issueId, candidate.issueId),
            ),
          )
          .for("update");
        if (!schedule) return "cancelled" as const;

        const [company] = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, candidate.companyId))
          .limit(1);
        const [agent] = await tx
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, schedule.assigneeAgentId))
          .limit(1);
        const decision = resolveDueIssueOneTimeSchedule({
          schedule: {
            dueAt: schedule.dueAt,
            assigneeAgentId: schedule.assigneeAgentId,
            cancelledAt: schedule.cancelledAt,
            wakeupRequestId: schedule.wakeupRequestId,
          },
          issue: {
            exists: Boolean(issue),
            status: issue?.status ?? null,
            hiddenAt: issue?.hiddenAt ?? null,
            assigneeAgentId: issue?.assigneeAgentId ?? null,
            assigneeUserId: issue?.assigneeUserId ?? null,
          },
          companyStatus: company?.status ?? null,
          agentCompanyId: agent?.companyId ?? null,
          companyId: candidate.companyId,
          agentExists: Boolean(agent),
          now,
        });

        if (decision.outcome === "invalidate") {
          await tx
            .update(issueOneTimeSchedules)
            .set({
              cancelledAt: now,
              cancellationReason: ISSUE_ONE_TIME_SCHEDULE_INVALIDATION_MESSAGES[decision.reason],
              updatedAt: now,
            })
            .where(
              and(
                eq(issueOneTimeSchedules.id, schedule.id),
                isNull(issueOneTimeSchedules.cancelledAt),
                isNull(issueOneTimeSchedules.wakeupRequestId),
              ),
            );
          return "invalidated" as const;
        }
        if (decision.outcome !== "dispatch") return decision.outcome;

        const [wake] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: schedule.companyId,
            agentId: schedule.assigneeAgentId,
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_ONE_TIME_SCHEDULE_WAKE_REASON,
            payload: {
              issueId: schedule.issueId,
              taskId: schedule.issueId,
              issueOneTimeScheduleId: schedule.id,
              scheduledRunAt: schedule.dueAt.toISOString(),
              scheduledRunTimeZone: schedule.timeZone,
            },
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: ONE_TIME_SCHEDULE_REQUESTED_BY,
            idempotencyKey: `issue-one-time-schedule:${schedule.id}`,
            requestedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!wake) throw new Error("Native schedule wake intent was not persisted");
        const [claimedSchedule] = await tx
          .update(issueOneTimeSchedules)
          .set({ wakeupRequestId: wake.id, updatedAt: now })
          .where(
            and(
              eq(issueOneTimeSchedules.id, schedule.id),
              isNull(issueOneTimeSchedules.cancelledAt),
              isNull(issueOneTimeSchedules.wakeupRequestId),
            ),
          )
          .returning({ id: issueOneTimeSchedules.id });
        if (!claimedSchedule) throw conflict("Schedule was cancelled before its wake intent could be committed");
        return "claimed" as const;
      });
      if (outcome === "claimed" || outcome === "invalidated") {
        await logIssueOneTimeScheduleUpdate(db, candidate);
      }
      if (outcome === "claimed") claimed += 1;
      if (outcome === "invalidated") invalidated += 1;
    }

    return { checked: candidates.length, claimed, invalidated };
  }


  return { get, create, cancel, tickDue };
}

async function readScheduleWith(
  db: IssueOneTimeScheduleReadDb,
  schedule: typeof issueOneTimeSchedules.$inferSelect,
): Promise<IssueOneTimeSchedule> {
  const [wake] = schedule.wakeupRequestId
    ? await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.id, schedule.wakeupRequestId),
            eq(agentWakeupRequests.companyId, schedule.companyId),
          ),
        )
        .limit(1)
    : [];
  const [dispatch] = wake
    ? await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, schedule.companyId),
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${wake.id}`),
          ),
        )
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .limit(1)
    : [];
  const effectiveWake = dispatch ?? wake ?? null;
  const runId = effectiveWake?.runId ?? wake?.runId ?? null;
  const [run] = runId
    ? await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, error: heartbeatRuns.error })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, schedule.companyId)))
        .limit(1)
    : [];
  const state = resolveIssueOneTimeScheduleStatus({
    schedule: {
      cancelledAt: schedule.cancelledAt,
      cancellationReason: schedule.cancellationReason,
      wakeupRequestId: schedule.wakeupRequestId,
    },
    wake: effectiveWake
      ? { status: effectiveWake.status, error: effectiveWake.error, runId: effectiveWake.runId }
      : wake
        ? { status: wake.status, error: wake.error, runId: wake.runId }
        : null,
    run: run ? { status: run.status, error: run.error } : null,
  });
  return {
    id: schedule.id,
    issueId: schedule.issueId,
    agentId: schedule.assigneeAgentId,
    dueAt: schedule.dueAt,
    timeZone: schedule.timeZone,
    status: state.status,
    cancellationReason: schedule.cancellationReason,
    wakeupRequestId: schedule.wakeupRequestId,
    runId: run?.id ?? runId,
    runStatus: run?.status ?? null,
    error: state.error,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}
