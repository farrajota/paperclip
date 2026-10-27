import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals, issues } from "@paperclipai/db";
import { goalOutcomeCheckins, goalOutcomeObservations, goalOutcomePeriods, goalOutcomeTargets } from "@paperclipai/db/schema/goal_outcomes";
import type { CreateOutcomeCheckin, CreateOutcomeTarget, OutcomeObservationInput } from "@paperclipai/shared/governance-outcomes";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { publishActivity, persistActivity } from "./activity-log.js";
import type { ActivityPublication } from "./activity-log.js";
import { authorizationDeniedDetails, authorizationService } from "./authorization.js";
import type { AuthorizationActor, AuthorizationResource } from "./authorization.js";
import { outcomeAggregationSchema, outcomeDirectionSchema } from "@paperclipai/shared/governance-outcomes";

type OutcomePrincipal = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
  actorSource: "agent_key" | "agent_jwt" | "local_implicit" | "session" | "board_key" | "mcp_oauth" | "cloud_tenant";
  sessionId?: string | null;
};

export type OutcomeActorContext = {
  authorizationActor: AuthorizationActor;
  principal: OutcomePrincipal;
};

type EvalTarget = {
  intervalStart: Date | string;
  intervalEnd: Date | string;
  direction: "increase" | "decrease" | "range";
  aggregation: "latest" | "sum";
  baselineValue: number | null;
  targetValue: number | null;
  rangeMin: number | null;
  rangeMax: number | null;
  unit: string;
  source: string;
  population: string;
  freshnessHours: number;
  maturityHours: number;
  guardrails: Array<{ name: string; direction: "min" | "max"; threshold: number }>;
};

type EvalObservation = {
  value: number;
  source: string;
  unit: string;
  population: string;
  windowStart: Date | string;
  windowEnd: Date | string;
  observedAt: Date | string;
  availableAt: Date | string;
  ingestedAt: Date | string;
  valid: boolean | string;
  guardrailValues?: Record<string, number>;
  supersededBy?: string | null;
};

export type OutcomeHealth = {
  status: "unknown" | "in_progress" | "achieved" | "guardrail_failed";
  value: number | null;
  reason: string | null;
  observedAt: Date | null;
  freshness: "fresh" | "stale" | "missing";
};

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function evaluateOutcomeHealth(target: EvalTarget, observations: EvalObservation[], now = new Date()): OutcomeHealth {
  const nowMs = now.getTime();
  const periodStart = timestamp(target.intervalStart);
  const periodEnd = timestamp(target.intervalEnd);
  if (nowMs < periodStart || nowMs >= periodEnd) return { status: "unknown", value: null, reason: "The target period is not current", observedAt: null, freshness: "missing" };

  const matches = observations.filter((row) => (row.valid === true || row.valid === "true") && !row.supersededBy
    && timestamp(row.windowStart) >= periodStart && timestamp(row.windowEnd) <= periodEnd
    && timestamp(row.windowStart) < timestamp(row.windowEnd)
    && timestamp(row.observedAt) >= timestamp(row.windowStart) && timestamp(row.observedAt) < timestamp(row.windowEnd)
    && row.source === target.source && row.unit === target.unit && row.population === target.population);
  if (!matches.length) return { status: "unknown", value: null, reason: "No valid observation matches this period, approved source, unit and population", observedAt: null, freshness: "missing" };

  matches.sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt));
  const latest = matches[matches.length - 1]!;
  const contributing = target.aggregation === "sum" ? matches : [latest];
  for (const row of contributing) {
    const observedAtMs = timestamp(row.observedAt);
    if (observedAtMs > nowMs) return { status: "unknown", value: null, reason: "A matching observation is from the future", observedAt: new Date(observedAtMs), freshness: "missing" };
    if (timestamp(row.availableAt) > nowMs || timestamp(row.ingestedAt) > nowMs) return { status: "unknown", value: null, reason: "Observation is not available yet", observedAt: new Date(observedAtMs), freshness: "missing" };
    if (timestamp(row.windowEnd) + target.maturityHours * 3600000 > nowMs) return { status: "unknown", value: null, reason: "The measurement window has not matured", observedAt: new Date(observedAtMs), freshness: "missing" };
  }

  let value = latest.value;
  if (target.aggregation === "sum") {
    const sorted = [...matches].sort((a, b) => timestamp(a.windowStart) - timestamp(b.windowStart));
    for (let index = 1; index < sorted.length; index++) {
      if (timestamp(sorted[index]!.windowStart) < timestamp(sorted[index - 1]!.windowEnd)) {
        return { status: "unknown", value: null, reason: "Overlapping sum windows cannot be aggregated", observedAt: null, freshness: "missing" };
      }
    }
    value = sorted.reduce((sum, row) => sum + row.value, 0);
    if (sorted.some((row) => nowMs - timestamp(row.observedAt) > target.freshnessHours * 3600000)) {
      return { status: "unknown", value: null, reason: "A sum observation is stale", observedAt: new Date(timestamp(latest.observedAt)), freshness: "stale" };
    }
  }

  const observedAt = new Date(timestamp(latest.observedAt));
  if (!Number.isFinite(value) || nowMs - observedAt.getTime() > target.freshnessHours * 3600000) {
    return { status: "unknown", value: null, reason: "The latest matching observation is stale", observedAt, freshness: "stale" };
  }
  const guardrailObservations = target.aggregation === "sum" ? matches : [latest];
  for (const measured of guardrailObservations) {
    for (const rule of target.guardrails) {
      const actual = measured.guardrailValues?.[rule.name];
      if (actual == null) return { status: "unknown", value: null, reason: `Guardrail evidence is missing: ${rule.name}`, observedAt: new Date(timestamp(measured.observedAt)), freshness: "missing" };
      if (rule.direction === "max" ? actual > rule.threshold : actual < rule.threshold) {
        return { status: "guardrail_failed", value, reason: `Guardrail failed: ${rule.name}`, observedAt: new Date(timestamp(measured.observedAt)), freshness: "fresh" };
      }
    }
  }
  if (target.direction === "range") {
    if (target.rangeMin == null || target.rangeMax == null) return { status: "unknown", value: null, reason: "The approved range is incomplete", observedAt, freshness: "missing" };
    return { status: value >= target.rangeMin && value <= target.rangeMax ? "achieved" : "in_progress", value, reason: null, observedAt, freshness: "fresh" };
  }
  if (target.targetValue == null) return { status: "unknown", value: null, reason: "The approved target value is missing", observedAt, freshness: "missing" };
  if (target.baselineValue != null && (target.direction === "increase" ? value < target.baselineValue : value > target.baselineValue)) {
    return { status: "guardrail_failed", value, reason: "Observation regressed beyond the approved baseline", observedAt, freshness: "fresh" };
  }
  const achieved = target.direction === "increase" ? value >= target.targetValue : value <= target.targetValue;
  return { status: achieved ? "achieved" : "in_progress", value, reason: null, observedAt, freshness: "fresh" };
}

function samePayload(
  row: typeof goalOutcomeObservations.$inferSelect,
  input: OutcomeObservationInput,
  correction?: { supersedesId: string; correctionReason: string },
): boolean {
  const ordered = (value: Record<string, number>) => JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  return row.source === input.source && row.sourceRevision === input.sourceRevision && row.sourceKey === input.sourceKey
    && row.value === input.value && row.unit === input.unit && row.population === input.population
    && row.windowStart.getTime() === Date.parse(input.windowStart) && row.windowEnd.getTime() === Date.parse(input.windowEnd)
    && row.observedAt.getTime() === Date.parse(input.observedAt) && row.availableAt.getTime() === Date.parse(input.availableAt)
    && ordered(row.guardrailValues) === ordered(input.guardrailValues)
    && row.supersedesId === (correction?.supersedesId ?? null)
    && row.correctionReason === (correction?.correctionReason ?? null);
}

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function writeOutcomeAudit(
  tx: DbTransaction,
  companyId: string,
  actor: OutcomeActorContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<ActivityPublication> {
  const principal = actor.principal;
  const { publication } = await persistActivity(tx as unknown as Db, {
    companyId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    agentId: principal.agentId,
    runId: principal.runId,
    agentApiKeyId: principal.agentApiKeyId,
    action,
    entityType,
    entityId,
    details: { ...details, actorSource: principal.actorSource, agentApiKeyId: principal.agentApiKeyId },
  });
  return publication;
}

type OutcomeIssue = {
  id: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  originKind: string | null;
  originId: string | null;
};

function issueResource(companyId: string, issue: OutcomeIssue): Extract<AuthorizationResource, { type: "issue" }> {
  return {
    type: "issue",
    companyId,
    issueId: issue.id,
    projectId: issue.projectId,
    parentIssueId: issue.parentId,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    status: issue.status,
    originKind: issue.originKind,
    originId: issue.originId,
  };
}

async function redactCheckinIssueReferences(
  db: Db,
  companyId: string,
  actor: OutcomeActorContext,
  checkins: Array<typeof goalOutcomeCheckins.$inferSelect>,
): Promise<Array<typeof goalOutcomeCheckins.$inferSelect>> {
  const issueIds = [...new Set(checkins.flatMap((checkin) => checkin.correctiveIssueId ? [checkin.correctiveIssueId] : []))];
  if (!issueIds.length) return checkins;
  const issueRows: OutcomeIssue[] = await db.select({
    id: issues.id,
    projectId: issues.projectId,
    parentId: issues.parentId,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
    status: issues.status,
    originKind: issues.originKind,
    originId: issues.originId,
  }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
  const decisions = await authorizationService(db).decideReads(actor.authorizationActor, issueRows.map((issue) => issueResource(companyId, issue)));
  const visibleIds = new Set(issueRows.filter((_issue, index) => decisions[index]?.allowed).map((issue) => issue.id));
  return checkins.map((checkin) => checkin.correctiveIssueId && !visibleIds.has(checkin.correctiveIssueId)
    ? { ...checkin, correctiveIssueId: null }
    : checkin);
}

async function authorizeOutcomeCompany(
  db: Db,
  companyId: string,
  actor: OutcomeActorContext,
  opaqueDenial = false,
): Promise<void> {
  const decision = await authorizationService(db).decide({
    actor: actor.authorizationActor,
    action: "company_scope:read",
    resource: { type: "company", companyId },
  });
  if (decision.allowed) return;
  if (opaqueDenial) throw notFound("Goal outcomes not found");
  throw forbidden("Outcome access denied", authorizationDeniedDetails(decision));
}

export function governanceOutcomeService(db: Db) {
  async function getGoal(companyId: string, goalId: string) {
    const [goal] = await db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.companyId, companyId))).limit(1);
    if (!goal) throw notFound("Goal not found");
    return goal;
  }

  async function canReadIssue(companyId: string, issueId: string, actor: OutcomeActorContext): Promise<boolean> {
    const [issue] = await db.select({
      id: issues.id,
      projectId: issues.projectId,
      parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      status: issues.status,
      originKind: issues.originKind,
      originId: issues.originId,
    }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
    if (!issue) return false;
    const decision = await authorizationService(db).decide({
      actor: actor.authorizationActor,
      action: "issue:read",
      resource: issueResource(companyId, issue),
    });
    return decision.allowed;
  }

  async function read(companyId: string, goalId: string, actor: OutcomeActorContext, now = new Date()) {
    await getGoal(companyId, goalId);
    await authorizeOutcomeCompany(db, companyId, actor, true);
    const periods = await db.select().from(goalOutcomePeriods).where(and(eq(goalOutcomePeriods.companyId, companyId), eq(goalOutcomePeriods.goalId, goalId))).orderBy(asc(goalOutcomePeriods.intervalStart));
    const targets = await db.select().from(goalOutcomeTargets).where(and(eq(goalOutcomeTargets.companyId, companyId), eq(goalOutcomeTargets.goalId, goalId))).orderBy(asc(goalOutcomeTargets.metricKey), asc(goalOutcomeTargets.revision));
    const observations = await db.select().from(goalOutcomeObservations).where(and(eq(goalOutcomeObservations.companyId, companyId), eq(goalOutcomeObservations.goalId, goalId))).orderBy(asc(goalOutcomeObservations.observedAt));
    const persistedCheckins = await db.select().from(goalOutcomeCheckins).where(and(eq(goalOutcomeCheckins.companyId, companyId), eq(goalOutcomeCheckins.goalId, goalId))).orderBy(desc(goalOutcomeCheckins.createdAt));
    const checkins = await redactCheckinIssueReferences(db, companyId, actor, persistedCheckins);
    const periodsById = new Map(periods.map((period) => [period.id, period]));
    const current = new Map<string, (typeof targets)[number]>();
    for (const target of targets) {
      const period = periodsById.get(target.periodId);
      if (period?.lifecycle !== "active" || now < period.intervalStart || now >= period.intervalEnd) continue;
      if (target.revision > (current.get(target.metricKey)?.revision ?? 0)) current.set(target.metricKey, target);
    }
    const correctionByObservation = new Map(observations.flatMap((row) => row.supersedesId ? [[row.supersedesId, row.id] as const] : []));
    const outcomes = [...current.values()].map((target) => {
      const period = periodsById.get(target.periodId);
      const targetObservations = observations.filter((row) => row.targetId === target.id)
        .map((row) => ({ ...row, supersededBy: correctionByObservation.get(row.id) ?? null }));
      const direction = outcomeDirectionSchema.safeParse(target.direction);
      const aggregation = outcomeAggregationSchema.safeParse(target.aggregation);
      const health = period?.lifecycle === "active" && direction.success && aggregation.success
        ? evaluateOutcomeHealth({
          ...target,
          direction: direction.data,
          aggregation: aggregation.data,
          intervalStart: period.intervalStart,
          intervalEnd: period.intervalEnd,
        }, targetObservations, now)
        : { status: "unknown" as const, value: null, reason: "Outcome period or target definition is inactive or incompatible", observedAt: null, freshness: "missing" as const };
      return { target, period, observations: targetObservations, health };
    });
    return { periods, targets, observations, checkins, outcomes };
  }

  return {
    read,
    async createTarget(companyId: string, goalId: string, input: CreateOutcomeTarget, actor: OutcomeActorContext) {
      if (actor.authorizationActor.type !== "board" || actor.principal.actorType !== "user") throw forbidden("Board access required to approve outcome targets");
      await getGoal(companyId, goalId);
      await authorizeOutcomeCompany(db, companyId, actor);
      if (input.ownerAgentId) {
        const [owner] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.ownerAgentId), eq(agents.companyId, companyId))).limit(1);
        if (!owner) throw unprocessable("Outcome owner must be an agent in this company");
      }
      const start = new Date(input.period.intervalStart);
      const end = new Date(input.period.intervalEnd);
      const result = await db.transaction(async (tx) => {
        const [lockedGoal] = await tx.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.companyId, companyId))).for("update");
        if (!lockedGoal) throw notFound("Goal not found");
        const history = await tx.select().from(goalOutcomeTargets).where(and(eq(goalOutcomeTargets.companyId, companyId), eq(goalOutcomeTargets.goalId, goalId), eq(goalOutcomeTargets.metricKey, input.metricKey))).orderBy(desc(goalOutcomeTargets.revision));
        const revision = history[0]?.revision ?? 0;
        if (revision !== input.expectedRevision) throw conflict("Outcome target revision changed; reload before proposing another target");

        let [period] = await tx.select().from(goalOutcomePeriods).where(and(
          eq(goalOutcomePeriods.companyId, companyId),
          eq(goalOutcomePeriods.goalId, goalId),
          eq(goalOutcomePeriods.label, input.period.label),
          eq(goalOutcomePeriods.intervalStart, start),
          eq(goalOutcomePeriods.intervalEnd, end),
        )).limit(1);
        if (period && period.timezone !== input.period.timezone) throw conflict("Period timezone is immutable once created");
        if (period && period.lifecycle !== input.period.lifecycle) throw conflict("Period lifecycle is immutable once created");
        if (!period) {
          [period] = await tx.insert(goalOutcomePeriods).values({
            companyId,
            goalId,
            label: input.period.label,
            timezone: input.period.timezone,
            intervalStart: start,
            intervalEnd: end,
            lifecycle: input.period.lifecycle,
          }).returning();
        }
        if (!period) throw conflict("Outcome reporting period could not be established");

        if (input.aggregation === "sum" && period.lifecycle === "active") {
          const priorTargets = await tx.select().from(goalOutcomeTargets).where(and(
            eq(goalOutcomeTargets.companyId, companyId),
            eq(goalOutcomeTargets.goalId, goalId),
            eq(goalOutcomeTargets.metricKey, input.metricKey),
          ));
          const effectiveByPeriod = new Map<string, (typeof priorTargets)[number]>();
          for (const prior of priorTargets) {
            if (prior.periodId === period.id) continue;
            const current = effectiveByPeriod.get(prior.periodId);
            if (!current || prior.revision > current.revision) effectiveByPeriod.set(prior.periodId, prior);
          }
          const otherPeriods = await tx.select().from(goalOutcomePeriods).where(and(eq(goalOutcomePeriods.companyId, companyId), eq(goalOutcomePeriods.goalId, goalId)));
          const otherPeriodsById = new Map(otherPeriods.map((row) => [row.id, row]));
          for (const prior of effectiveByPeriod.values()) {
            if (prior.aggregation !== "sum") continue;
            const otherPeriod = otherPeriodsById.get(prior.periodId);
            if (otherPeriod?.lifecycle === "active" && otherPeriod.intervalStart < end && otherPeriod.intervalEnd > start) {
              throw conflict("Active sum target periods for the same metric must not overlap");
            }
          }
        }

        const [target] = await tx.insert(goalOutcomeTargets).values({
          companyId,
          goalId,
          periodId: period.id,
          metricKey: input.metricKey,
          revision: revision + 1,
          kind: input.kind,
          unit: input.unit,
          direction: input.direction,
          aggregation: input.aggregation,
          population: input.population,
          source: input.source,
          queryVersion: input.queryVersion,
          freshnessHours: input.freshnessHours,
          maturityHours: input.maturityHours,
          baselineValue: input.baselineValue ?? null,
          targetValue: input.targetValue ?? null,
          rangeMin: input.rangeMin ?? null,
          rangeMax: input.rangeMax ?? null,
          ownerAgentId: input.ownerAgentId ?? null,
          guardrails: input.guardrails,
          trajectory: input.trajectory,
          approvedBy: actor.principal.actorId,
        }).returning();
        if (!target) throw conflict("Outcome target revision could not be created");
        const publication = await writeOutcomeAudit(tx, companyId, actor, "goal_outcome.target.created", "goal_outcome_target", target.id, {
          goalId,
          metricKey: target.metricKey,
          revision: target.revision,
          periodId: period.id,
        });
        return { target, publication };
      });
      publishActivity(result.publication);
      return result.target;
    },
    async addObservation(
      companyId: string,
      goalId: string,
      input: OutcomeObservationInput,
      actor: OutcomeActorContext,
      correction?: { supersedesId: string; correctionReason: string },
      ingestedAt = new Date(),
    ) {
      await getGoal(companyId, goalId);
      await authorizeOutcomeCompany(db, companyId, actor);
      const normalizedCorrection = correction ? { ...correction, correctionReason: correction.correctionReason.trim() } : undefined;
      const windowStart = new Date(input.windowStart);
      const windowEnd = new Date(input.windowEnd);
      const observedAt = new Date(input.observedAt);
      const availableAt = new Date(input.availableAt);
      return db.transaction(async (tx) => {
        const [target] = await tx.select().from(goalOutcomeTargets).where(and(
          eq(goalOutcomeTargets.id, input.targetId),
          eq(goalOutcomeTargets.goalId, goalId),
          eq(goalOutcomeTargets.companyId, companyId),
        )).for("update");
        if (!target) throw notFound("Outcome target not found");
        if (actor.principal.actorType === "agent" && target.ownerAgentId !== actor.principal.agentId) {
          throw unprocessable("Only the explicitly assigned metric owner may submit an observation");
        }
        const [period] = await tx.select().from(goalOutcomePeriods).where(and(
          eq(goalOutcomePeriods.id, target.periodId),
          eq(goalOutcomePeriods.companyId, companyId),
          eq(goalOutcomePeriods.goalId, goalId),
        )).limit(1);
        if (!period) throw notFound("Outcome period not found");
        if (input.unit !== target.unit || input.population !== target.population
          || windowStart < period.intervalStart || windowEnd > period.intervalEnd || windowStart >= windowEnd
          || observedAt < windowStart || observedAt >= windowEnd || availableAt < observedAt) {
          throw unprocessable("Observation does not match the target unit, population, availability, or period window");
        }
        if (input.source !== target.source) throw unprocessable("Observation source does not match the approved target source");

        const [duplicate] = await tx.select().from(goalOutcomeObservations).where(and(
          eq(goalOutcomeObservations.targetId, target.id),
          eq(goalOutcomeObservations.source, input.source),
          eq(goalOutcomeObservations.sourceKey, input.sourceKey),
        )).limit(1);
        if (duplicate) {
          if (samePayload(duplicate, input, normalizedCorrection)) return { observation: duplicate, reused: true as const };
          throw conflict("Source key already identifies a different observation");
        }

        if (normalizedCorrection) {
          if (!normalizedCorrection.correctionReason) throw unprocessable("A correction reason is required");
          const [old] = await tx.select().from(goalOutcomeObservations).where(and(
            eq(goalOutcomeObservations.id, normalizedCorrection.supersedesId),
            eq(goalOutcomeObservations.targetId, target.id),
            eq(goalOutcomeObservations.companyId, companyId),
            eq(goalOutcomeObservations.goalId, goalId),
          )).limit(1);
          if (!old) throw notFound("Observation to correct not found");
          const [alreadyCorrected] = await tx.select({ id: goalOutcomeObservations.id }).from(goalOutcomeObservations)
            .where(eq(goalOutcomeObservations.supersedesId, normalizedCorrection.supersedesId)).limit(1);
          if (alreadyCorrected) throw conflict("Observation already has a correction");
        }

        if (target.aggregation === "sum") {
          const prior = await tx.select().from(goalOutcomeObservations).where(and(
            eq(goalOutcomeObservations.targetId, target.id),
            eq(goalOutcomeObservations.valid, "true"),
          ));
          const superseded = new Set(prior.flatMap((row) => row.supersedesId ? [row.supersedesId] : []));
          for (const row of prior) {
            if (!superseded.has(row.id) && row.id !== normalizedCorrection?.supersedesId
              && row.windowStart < windowEnd && row.windowEnd > windowStart) {
              throw conflict("Sum observation windows must not overlap");
            }
          }
        }

        const [observation] = await tx.insert(goalOutcomeObservations).values({
          companyId,
          goalId,
          targetId: target.id,
          source: input.source,
          sourceRevision: input.sourceRevision,
          sourceKey: input.sourceKey,
          value: input.value,
          unit: input.unit,
          population: input.population,
          windowStart,
          windowEnd,
          observedAt,
          availableAt,
          ingestedAt,
          submittedBy: actor.principal.actorId,
          submitterType: actor.principal.actorType,
          submitterSource: actor.principal.actorSource,
          submitterKeyId: actor.principal.agentApiKeyId,
          runId: actor.principal.runId,
          guardrailValues: input.guardrailValues,
          supersedesId: normalizedCorrection?.supersedesId ?? null,
          correctionReason: normalizedCorrection?.correctionReason ?? null,
        }).returning();
        if (!observation) throw conflict("Outcome observation could not be recorded");
        const publication = await writeOutcomeAudit(tx, companyId, actor,
          normalizedCorrection ? "goal_outcome.observation.corrected" : "goal_outcome.observation.created",
          "goal_outcome_observation", observation.id, {
            goalId,
            targetId: target.id,
            source: input.source,
            sourceRevision: input.sourceRevision,
            sourceKey: input.sourceKey,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            observedAt: input.observedAt,
            availableAt: input.availableAt,
            supersedesId: normalizedCorrection?.supersedesId ?? null,
            correctionReason: normalizedCorrection?.correctionReason ?? null,
          });
        return { observation, reused: false as const, publication };
      }).then((result) => {
        if (result.reused) return result;
        publishActivity(result.publication);
        return { observation: result.observation, reused: false };
      });
    },
    async addCheckin(companyId: string, goalId: string, input: CreateOutcomeCheckin, actor: OutcomeActorContext) {
      await getGoal(companyId, goalId);
      await authorizeOutcomeCompany(db, companyId, actor);
      const [target] = await db.select().from(goalOutcomeTargets).where(and(
        eq(goalOutcomeTargets.id, input.targetId),
        eq(goalOutcomeTargets.goalId, goalId),
        eq(goalOutcomeTargets.companyId, companyId),
      )).limit(1);
      if (!target) throw notFound("Outcome target not found");
      if (input.correctiveIssueId && !(await canReadIssue(companyId, input.correctiveIssueId, actor))) {
        throw unprocessable("Corrective issue reference is not available");
      }
      const result = await db.transaction(async (tx) => {
        const [checkin] = await tx.insert(goalOutcomeCheckins).values({
          companyId,
          goalId,
          targetId: target.id,
          health: input.health,
          evidence: input.evidence,
          forecastValue: input.forecastValue ?? null,
          uncertainty: input.uncertainty,
          correctiveIssueId: input.correctiveIssueId ?? null,
          nextReviewAt: new Date(input.nextReviewAt),
          createdBy: actor.principal.actorId,
        }).returning();
        if (!checkin) throw conflict("Outcome check-in could not be recorded");
        const publication = await writeOutcomeAudit(tx, companyId, actor, "goal_outcome.checkin.created", "goal_outcome_checkin", checkin.id, {
          goalId,
          targetId: target.id,
          health: input.health,
          nextReviewAt: input.nextReviewAt,
        });
        return { checkin, publication };
      });
      publishActivity(result.publication);
      return result.checkin;
    },
  };
}
