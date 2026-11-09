import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";

export function listAttentionExhaustedRuns(db: Db, companyId: string) {
  // Find only the latest matching exhaustion receipt for each outer run.
  const latestExhaustion = db
    .select({
      eventId: heartbeatRunEvents.id,
      message: heartbeatRunEvents.message,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.runId, heartbeatRuns.id),
      eq(heartbeatRunEvents.eventType, "lifecycle"),
      sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
    ))
    .orderBy(desc(heartbeatRunEvents.id))
    .limit(1)
    .as("latest_exhaustion");

  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      // Preserve JSON types and issueId/taskId fallback semantics without
      // transferring prompts, transcripts, or the rest of the run context.
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
        'issueId', ${heartbeatRuns.contextSnapshot} -> 'issueId',
        'taskId', ${heartbeatRuns.contextSnapshot} -> 'taskId'
      )`,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      finishedAt: heartbeatRuns.finishedAt,
      exhaustionMessage: latestExhaustion.message,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoinLateral(latestExhaustion, sql`true`)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(agents.companyId, companyId),
      notInArray(agents.status, ["terminated"]),
      inArray(heartbeatRuns.status, ["failed", "timed_out"]),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(latestExhaustion.eventId));
}
