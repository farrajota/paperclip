import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Goal } from "@paperclipai/shared";
import { z } from "zod";
import { outcomeGuardrailSchema, outcomeTrajectorySchema } from "@paperclipai/shared/governance-outcomes";
import { governanceOutcomesApi } from "../api/governance-outcomes";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useAccountIdentity } from "../api/companies-query";
import { Button } from "@/components/ui/button";

function Input({ label, value, onChange, type = "text", readOnly = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; readOnly?: boolean }) {
  return <label className="grid gap-1 text-xs text-muted-foreground">{label}<input className="rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" type={type} step={type === "datetime-local" ? "0.001" : undefined} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} /></label>;
}
function calendarDateInTimeZone(instant: string, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
type LoadedPeriodBounds = { timezone: string; intervalStart: string; intervalEnd: string; startDate: string; endDate: string };
function calendarMidnightInTimeZone(date: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
    const displayed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const adjustment = desired - displayed;
    instant += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(instant).toISOString();
}


export function GoalOutcomes({ goal }: { goal: Goal }) {
  const accountIdentity = useAccountIdentity();
  return <GoalOutcomesForAccount key={`${goal.companyId}:${goal.id}:${accountIdentity.userId ?? "anonymous"}`} goal={goal} accountUserId={accountIdentity.userId} identityReady={accountIdentity.settled || accountIdentity.failed} />;
}

function GoalOutcomesForAccount({ goal, accountUserId, identityReady }: { goal: Goal; accountUserId: string | null; identityReady: boolean }) {
  const queryClient = useQueryClient();
  const key = queryKeys.goals.outcomes(goal.id, accountUserId);
  const query = useQuery({ queryKey: key, queryFn: () => governanceOutcomesApi.get(goal.id), enabled: identityReady });
  const delivery = useQuery({ queryKey: queryKeys.goals.outcomeDelivery(goal.companyId, goal.id, accountUserId), queryFn: () => issuesApi.listAll(goal.companyId, {}).then((rows) => rows.filter((issue) => issue.goalId === goal.id)), enabled: identityReady });
  const [metricKey, setMetricKey] = useState("");
  const [periodLabel, setPeriodLabel] = useState("Current period");
  const [timezone, setTimezone] = useState("UTC");
  const [intervalStart, setIntervalStart] = useState(new Date().toISOString().slice(0, 10));
  const [intervalEnd, setIntervalEnd] = useState(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  const [periodLifecycle, setPeriodLifecycle] = useState<"draft" | "active" | "closed">("active");
  const [loadedPeriodBounds, setLoadedPeriodBounds] = useState<LoadedPeriodBounds | null>(null);
  const [proposalTargetId, setProposalTargetId] = useState("");
  const [proposalExpectedRevision, setProposalExpectedRevision] = useState(0);
  const [targetEditorOpen, setTargetEditorOpen] = useState(false);
  const [kind, setKind] = useState<"number" | "percentage" | "currency" | "duration" | "count">("number");
  const [unit, setUnit] = useState("");
  const [direction, setDirection] = useState<"increase" | "decrease" | "range">("increase");
  const [aggregation, setAggregation] = useState<"latest" | "sum">("latest");
  const [population, setPopulation] = useState("");
  const [source, setSource] = useState("manual");
  const [queryVersion, setQueryVersion] = useState("1");
  const [freshnessHours, setFreshnessHours] = useState("48");
  const [maturityHours, setMaturityHours] = useState("24");
  const [baselineValue, setBaselineValue] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [rangeMin, setRangeMin] = useState("");
  const [rangeMax, setRangeMax] = useState("");
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [guardrailsJson, setGuardrailsJson] = useState("[]");
  const [trajectoryJson, setTrajectoryJson] = useState("[]");
  const [observationTarget, setObservationTarget] = useState("");
  const [windowStartAt, setWindowStartAt] = useState(() => new Date(Date.now() - 3600000).toISOString().slice(0, -1));
  const [windowEndAt, setWindowEndAt] = useState(() => new Date(Date.now() + 3600000).toISOString().slice(0, -1));
  const [guardrailValuesJson, setGuardrailValuesJson] = useState("{}");
  const [observationValue, setObservationValue] = useState("");
  const [sourceRevision, setSourceRevision] = useState("1");
  const [sourceKey, setSourceKey] = useState("");
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString().slice(0, -1));
  const [availableAt, setAvailableAt] = useState(() => new Date().toISOString().slice(0, -1));
  const [supersedesId, setSupersedesId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [checkinEvidence, setCheckinEvidence] = useState("");
  const [correctiveIssueId, setCorrectiveIssueId] = useState("");
  const [forecast, setForecast] = useState("");
  const [uncertainty, setUncertainty] = useState("");
  const [nextReviewAt, setNextReviewAt] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, -1));

  const loadTargetForRevision = (targetId: string) => {
    const existing = query.data?.targets.find((row) => row.id === targetId);
    const period = query.data?.periods.find((row) => row.id === existing?.periodId);
    if (!existing || !period) return;
    const startDate = calendarDateInTimeZone(period.intervalStart, period.timezone);
    const endDate = calendarDateInTimeZone(period.intervalEnd, period.timezone);
    setProposalTargetId(existing.id);
    setProposalExpectedRevision(existing.revision);
    setLoadedPeriodBounds({ timezone: period.timezone, intervalStart: period.intervalStart, intervalEnd: period.intervalEnd, startDate, endDate });
    setObservationTarget(existing.id);
    setSupersedesId("");
    setCorrectionReason("");
    setMetricKey(existing.metricKey);
    setPeriodLabel(period.label);
    setTimezone(period.timezone);
    setIntervalStart(startDate);
    setIntervalEnd(endDate);
    setPeriodLifecycle(period.lifecycle);
    setKind(existing.kind);
    setUnit(existing.unit);
    setDirection(existing.direction);
    setAggregation(existing.aggregation);
    setPopulation(existing.population);
    setSource(existing.source);
    setQueryVersion(existing.queryVersion);
    setFreshnessHours(String(existing.freshnessHours));
    setMaturityHours(String(existing.maturityHours));
    setBaselineValue(existing.baselineValue == null ? "" : String(existing.baselineValue));
    setTargetValue(existing.targetValue == null ? "" : String(existing.targetValue));
    setRangeMin(existing.rangeMin == null ? "" : String(existing.rangeMin));
    setRangeMax(existing.rangeMax == null ? "" : String(existing.rangeMax));
    setOwnerAgentId(existing.ownerAgentId ?? "");
    setGuardrailsJson(JSON.stringify(existing.guardrails, null, 2));
    setTrajectoryJson(JSON.stringify(existing.trajectory, null, 2));
    setTargetEditorOpen(true);
  };

  const startNewTarget = () => {
    const now = new Date();
    setProposalTargetId("");
    setProposalExpectedRevision(0);
    setLoadedPeriodBounds(null);
    setMetricKey("");
    setPeriodLabel("Current period");
    setTimezone("UTC");
    setIntervalStart(now.toISOString().slice(0, 10));
    setIntervalEnd(new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10));
    setPeriodLifecycle("active");
    setKind("number");
    setUnit("");
    setDirection("increase");
    setAggregation("latest");
    setPopulation("");
    setSource("manual");
    setQueryVersion("1");
    setFreshnessHours("48");
    setMaturityHours("24");
    setBaselineValue("");
    setTargetValue("");
    setRangeMin("");
    setRangeMax("");
    setOwnerAgentId("");
    setGuardrailsJson("[]");
    setTrajectoryJson("[]");
    setTargetEditorOpen(true);
  };

  const saveAndReload = async () => {
    await queryClient.invalidateQueries({ queryKey: key });
    await query.refetch();
  };
  const targetMutation = useMutation({
    mutationFn: async () => {
      const period = {
        label: periodLabel,
        timezone,
        intervalStart: loadedPeriodBounds?.timezone === timezone && loadedPeriodBounds.startDate === intervalStart
          ? loadedPeriodBounds.intervalStart : calendarMidnightInTimeZone(intervalStart, timezone),
        intervalEnd: loadedPeriodBounds?.timezone === timezone && loadedPeriodBounds.endDate === intervalEnd
          ? loadedPeriodBounds.intervalEnd : calendarMidnightInTimeZone(intervalEnd, timezone),
        lifecycle: periodLifecycle,
      };
      const target = await governanceOutcomesApi.createTarget(goal.id, {
        expectedRevision: proposalExpectedRevision,
        period,
        metricKey,
        kind,
        unit,
        direction,
        aggregation,
        population,
        source,
        queryVersion,
        freshnessHours: Number(freshnessHours),
        maturityHours: Number(maturityHours),
        baselineValue: baselineValue === "" ? null : Number(baselineValue),
        targetValue: targetValue === "" ? null : Number(targetValue),
        rangeMin: rangeMin === "" ? null : Number(rangeMin),
        rangeMax: rangeMax === "" ? null : Number(rangeMax),
        ownerAgentId: ownerAgentId || null,
        guardrails: outcomeGuardrailSchema.array().parse(JSON.parse(guardrailsJson)),
        trajectory: outcomeTrajectorySchema.parse(JSON.parse(trajectoryJson)),
      });
      return { target, period };
    },
    onSuccess: async ({ target, period }) => {
      const startDate = calendarDateInTimeZone(period.intervalStart, period.timezone);
      const endDate = calendarDateInTimeZone(period.intervalEnd, period.timezone);
      setProposalTargetId(target.id);
      setProposalExpectedRevision(target.revision);
      setLoadedPeriodBounds({ ...period, startDate, endDate });
      setObservationTarget(target.id);
      setSupersedesId("");
      setCorrectionReason("");
      await saveAndReload();
    },
  });

  const selectedTarget = query.data?.targets.find((target) => target.id === observationTarget)
    ?? query.data?.outcomes[0]?.target
    ?? query.data?.targets.at(-1);
  const matchingObservations = useMemo(() => query.data?.observations.filter((observation) => observation.targetId === selectedTarget?.id) ?? [], [query.data?.observations, selectedTarget?.id]);
  const superseded = new Set(matchingObservations.flatMap((observation) => observation.supersedesId ? [observation.supersedesId] : []));
  const observationInput = () => {
    if (!selectedTarget || !query.data) throw new Error("Select a saved target before recording an observation");
    const period = query.data.periods.find((row) => row.id === selectedTarget.periodId);
    if (!period) throw new Error("The target period is unavailable");
    return {
      targetId: selectedTarget.id,
      source: selectedTarget.source,
      sourceRevision,
      sourceKey,
      value: Number(observationValue),
      unit: selectedTarget.unit,
      population: selectedTarget.population,
      windowStart: new Date(`${windowStartAt}Z`).toISOString(),
      windowEnd: new Date(`${windowEndAt}Z`).toISOString(),
      observedAt: new Date(`${observedAt}Z`).toISOString(),
      availableAt: new Date(`${availableAt}Z`).toISOString(),
      guardrailValues: z.record(z.string(), z.number().finite()).parse(JSON.parse(guardrailValuesJson)),
    };
  };
  const observationMutation = useMutation({
    mutationFn: () => {
      const input = observationInput();
      return supersedesId
        ? governanceOutcomesApi.correctObservation(goal.id, { ...input, supersedesId, correctionReason })
        : governanceOutcomesApi.addObservation(goal.id, input);
    },
    onSuccess: async () => {
      setSupersedesId("");
      setCorrectionReason("");
      await saveAndReload();
    },
  });
  const checkinMutation = useMutation({
    mutationFn: () => {
      if (!selectedTarget) throw new Error("Select a saved target before checking in");
      const status = query.data?.outcomes.find((outcome) => outcome.target.id === selectedTarget.id)?.health.status;
      const health = status === "achieved" ? "on_track" : status === "in_progress" ? "at_risk" : status === "guardrail_failed" ? "off_track" : "unknown";
      return governanceOutcomesApi.addCheckin(goal.id, {
        targetId: selectedTarget.id,
        health,
        evidence: checkinEvidence,
        forecastValue: forecast === "" ? null : Number(forecast),
        uncertainty,
        correctiveIssueId: correctiveIssueId || null,
        nextReviewAt: new Date(`${nextReviewAt}Z`).toISOString(),
      });
    },
    onSuccess: saveAndReload,
  });

  if (!identityReady || query.isPending) return <section aria-busy="true" className="rounded border border-border p-4 text-sm text-muted-foreground">Loading outcome measurements…</section>;
  if (query.error) return <section className="rounded border border-destructive/40 p-4 text-sm text-destructive"><p>Outcome data could not be loaded: {query.error.message}</p><Button size="sm" variant="outline" onClick={() => void query.refetch()}>Retry</Button></section>;
  if (!query.data) return <p className="text-sm text-muted-foreground">Outcome data is unavailable.</p>;
  const completed = (delivery.data ?? []).filter((issue) => issue.status === "done").length;
  const deliveryTotal = delivery.data?.length ?? 0;
  const targetsById = new Map(query.data.targets.map((target) => [target.id, target]));
  const supersededObservationIds = new Set(query.data.observations.flatMap((observation) => observation.supersedesId ? [observation.supersedesId] : []));
  const targetValueValid = direction === "range" ? rangeMin !== "" && rangeMax !== "" : targetValue !== "";
  const capabilities = query.data.capabilities;
  const canObserve = Boolean(selectedTarget && capabilities.observationTargetIds.includes(selectedTarget.id));

  return <section className="space-y-5 rounded border border-border p-4" aria-label="Goal outcomes">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="font-semibold">Outcome and delivery</h3><p className="text-xs text-muted-foreground">Delivery counts authorized visible linked issues only; it is not evidence that the outcome was achieved.</p></div>
      <Button size="sm" variant="outline" onClick={() => void Promise.all([query.refetch(), delivery.refetch()])}>Reload</Button>
    </header>
    <p className="text-xs text-muted-foreground" role="status">{capabilities.explanation}</p>
    <p className="text-xs text-muted-foreground">Measurement windows, observation/availability times and next review inputs use UTC, not browser-local time, with millisecond precision. Period dates use the period's IANA timezone; history timestamps are displayed in your browser timezone.</p>

    <div className="rounded bg-muted/30 p-3">
      <h4 className="text-sm font-medium">Delivery progress</h4>
      {delivery.isLoading ? <p className="text-xs text-muted-foreground">Loading authorized issue pages…</p>
        : delivery.error ? <p className="text-xs text-destructive">Delivery progress could not be loaded: {delivery.error.message}</p>
          : deliveryTotal ? <><p className="text-sm">{completed} of {deliveryTotal} visible linked issues completed ({Math.round(completed / deliveryTotal * 100)}%).</p><ul className="mt-2 space-y-1 text-xs">{delivery.data?.map((issue) => <li key={issue.id}><Link className="text-primary underline" to={`/issues/${issue.identifier ?? issue.id}`}>{issue.identifier ?? issue.title}</Link> · {issue.status}</li>)}</ul></>
            : <p className="text-sm">No visible issues are directly linked to this goal.</p>}
    </div>

    <div>
      <h4 className="mb-2 text-sm font-medium">Measured outcomes</h4>
      {query.data.outcomes.length ? <div className="space-y-2">{query.data.outcomes.map(({ target, period, health }) => <article key={target.id} className="rounded border border-border p-3">
        <div className="flex flex-wrap justify-between gap-2"><strong>{target.metricKey} · revision {target.revision}</strong><span className="text-sm">{health.status.replaceAll("_", " ")}</span></div>
        <p className="text-sm">{health.value == null ? "Value unknown" : `${health.value} ${target.unit}`} · target {target.direction === "range" ? `${target.rangeMin}–${target.rangeMax}` : target.targetValue} {target.unit}</p>
        <p className="text-xs text-muted-foreground">{period?.label ?? "Unknown period"} ({period?.timezone ?? "timezone unavailable"}) · {period ? `${calendarDateInTimeZone(period.intervalStart, period.timezone)}–${calendarDateInTimeZone(period.intervalEnd, period.timezone)} exclusive end` : "period unavailable"} · source {target.source} · query {target.queryVersion} · freshness {health.freshness} · maturity {target.maturityHours}h{health.observedAt ? ` · observed ${new Date(health.observedAt).toLocaleString()}` : ""}</p>
        {health.reason && <p className="text-xs text-muted-foreground">{health.reason}</p>}
      </article>)}</div> : <p className="text-sm text-muted-foreground">Outcome is unknown: no current active target revision has an eligible observation.</p>}
    </div>

    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Target revision audit ({query.data.targets.length} immutable revisions)</summary>
      <ol className="mt-2 space-y-2 text-xs">{query.data.targets.map((target) => {
        const period = query.data.periods.find((row) => row.id === target.periodId);
        return <li key={target.id} className="border-l-2 border-border pl-2">
          <strong>{target.metricKey} revision {target.revision}</strong> · approved by {target.approvedBy} · {new Date(target.createdAt).toLocaleString()}
          <p>{target.direction}/{target.aggregation} · target {target.direction === "range" ? `${target.rangeMin}–${target.rangeMax}` : target.targetValue} {target.unit} · baseline {target.baselineValue ?? "not set"} · population {target.population}</p>
          <p>{period?.label ?? "Unknown period"} · {period?.lifecycle ?? "unknown lifecycle"} · {period?.timezone ?? "timezone unavailable"} · {period ? `${calendarDateInTimeZone(period.intervalStart, period.timezone)}–${calendarDateInTimeZone(period.intervalEnd, period.timezone)} (end exclusive)` : "period interval unavailable"} · source {target.source} query {target.queryVersion} · freshness {target.freshnessHours}h / maturity {target.maturityHours}h · owner {target.ownerAgentId ?? "unassigned"} · {target.guardrails.length} guardrails · {target.trajectory.length} trajectory points</p>
          <Button size="sm" variant="ghost" className="ml-1 h-7" disabled={!capabilities.canApproveTargets} onClick={() => loadTargetForRevision(target.id)}>Propose next revision</Button>
        </li>;
      })}</ol>
    </details>

    <details className="rounded border border-border p-3" open={targetEditorOpen} onToggle={(event) => setTargetEditorOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">Propose or revise a board-approved target</summary>
      <fieldset disabled={!capabilities.canApproveTargets} className="min-w-0">
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted-foreground">Load a saved target to propose its next revision<select value={proposalTargetId} onChange={(event) => event.target.value ? loadTargetForRevision(event.target.value) : startNewTarget()} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="">New metric (revision 1)</option>{query.data.targets.map((target) => <option key={target.id} value={target.id}>{target.metricKey} revision {target.revision}</option>)}</select></label>
        <Input label="Metric key" value={metricKey} onChange={setMetricKey} readOnly={Boolean(proposalTargetId)}/>
        <Input label="Period label" value={periodLabel} onChange={setPeriodLabel}/>
        <Input label="Timezone (IANA)" value={timezone} onChange={setTimezone}/>
        <Input label="Period start" type="date" value={intervalStart} onChange={setIntervalStart}/>
        <Input label="Period end (exclusive)" type="date" value={intervalEnd} onChange={setIntervalEnd}/>
        <label className="grid gap-1 text-xs text-muted-foreground">Period lifecycle<select value={periodLifecycle} onChange={(event) => setPeriodLifecycle(event.target.value as typeof periodLifecycle)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="draft">Draft</option><option value="active">Active</option><option value="closed">Closed</option></select></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Metric kind<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option>number</option><option>percentage</option><option>currency</option><option>duration</option><option>count</option></select></label>
        <Input label="Unit" value={unit} onChange={setUnit}/>
        <label className="grid gap-1 text-xs text-muted-foreground">Direction<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="increase">Increase</option><option value="decrease">Decrease</option><option value="range">Range</option></select></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Aggregation<select value={aggregation} onChange={(event) => setAggregation(event.target.value as typeof aggregation)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="latest">Latest observation</option><option value="sum">Non-overlapping sum</option></select></label>
        <Input label="Population / cohort" value={population} onChange={setPopulation}/>
        <Input label="Approved source name" value={source} onChange={setSource}/>
        <Input label="Source query version" value={queryVersion} onChange={setQueryVersion}/>
        <Input label="Freshness limit (hours)" type="number" value={freshnessHours} onChange={setFreshnessHours}/>
        <Input label="Measurement maturity (hours after window end)" type="number" value={maturityHours} onChange={setMaturityHours}/>
        <Input label="Baseline" type="number" value={baselineValue} onChange={setBaselineValue}/>
        <Input label={direction === "range" ? "Lower range bound" : "Target"} type="number" value={direction === "range" ? rangeMin : targetValue} onChange={direction === "range" ? setRangeMin : setTargetValue}/>
        {direction === "range" && <Input label="Upper range bound" type="number" value={rangeMax} onChange={setRangeMax}/>}
        <Input label="Accountable owner agent ID (optional)" value={ownerAgentId} onChange={setOwnerAgentId}/>
        <label className="grid gap-1 text-xs text-muted-foreground">Guardrails JSON (name, direction min/max, threshold)<textarea value={guardrailsJson} onChange={(event) => setGuardrailsJson(event.target.value)} className="min-h-20 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground" /></label>
        <label className="grid gap-1 text-xs text-muted-foreground">Trajectory JSON (ISO timestamp and value)<textarea value={trajectoryJson} onChange={(event) => setTrajectoryJson(event.target.value)} className="min-h-20 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground" /></label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Only board users can approve targets. The compare-and-swap expectation is revision {proposalExpectedRevision} captured when this proposal was loaded; a background refresh never advances it. Period definitions and lifecycle are immutable—changed dates, timezone, label, or lifecycle require a distinct period.</p>
      <Button className="mt-2" size="sm" disabled={targetMutation.isPending || !metricKey || !unit || !population || !targetValueValid || Number(freshnessHours) <= 0 || Number(maturityHours) <= 0} onClick={() => targetMutation.mutate()}>{proposalTargetId ? `Save revision ${proposalExpectedRevision + 1}` : "Create target revision 1"}</Button>
      {targetMutation.error && <p role="alert" className="mt-2 text-xs text-destructive">Target was not saved: {targetMutation.error.message}. Reload and load the current revision before resolving a compare-and-swap conflict.</p>}
      </fieldset>
    </details>
    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Record an observation or correction</summary>
      <fieldset disabled={capabilities.observationTargetIds.length === 0} className="min-w-0">
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted-foreground">Target<select value={observationTarget} onChange={(event) => { setObservationTarget(event.target.value); setSupersedesId(""); setCorrectionReason(""); }} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="">{selectedTarget ? `Default: ${selectedTarget.metricKey} revision ${selectedTarget.revision}` : "No saved target"}</option>{query.data.targets.map((target) => <option key={target.id} value={target.id}>{target.metricKey} revision {target.revision}</option>)}</select></label>
        <Input label="Numeric value" type="number" value={observationValue} onChange={setObservationValue}/>
        <Input label="Source revision" value={sourceRevision} onChange={setSourceRevision}/>
        <Input label="Stable source key" value={sourceKey} onChange={setSourceKey}/>
        <Input label="Observed at (UTC)" type="datetime-local" value={observedAt} onChange={setObservedAt}/>
        <Input label="Available at (UTC)" type="datetime-local" value={availableAt} onChange={setAvailableAt}/>
        <label className="grid gap-1 text-xs text-muted-foreground">Correct prior observation<select value={supersedesId} onChange={(event) => setSupersedesId(event.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="">New observation</option>{matchingObservations.filter((observation) => !superseded.has(observation.id)).map((observation) => <option key={observation.id} value={observation.id}>{observation.value} {observation.unit} · {observation.id.slice(0, 8)}</option>)}</select></label>
        {supersedesId && <Input label="Correction reason" value={correctionReason} onChange={setCorrectionReason}/>}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">The source key is stable across retries; corrections append a replacement and retain the original record.</p>
      <Button className="mt-2" size="sm" disabled={!canObserve || observationMutation.isPending || !selectedTarget || !sourceKey || observationValue === "" || Boolean(supersedesId && !correctionReason)} onClick={() => observationMutation.mutate()}>Append observation</Button>
      {observationMutation.error && <p role="alert" className="mt-2 text-xs text-destructive">Observation was not saved: {observationMutation.error.message}</p>}
      {!canObserve && <p className="mt-2 text-xs text-muted-foreground">Recording observations requires company write access and, for agents, explicit ownership of the selected target.</p>}
      </fieldset>
    </details>

    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Observation window and guardrail readings</summary>
      <p className="mt-2 text-xs text-muted-foreground">Sum metrics require distinct, non-overlapping windows. Window endpoints, observed time, availability, freshness, and maturity are evaluated separately.</p>
      <fieldset disabled={!canObserve} className="min-w-0"><div className="mt-3 grid gap-3 sm:grid-cols-2"><Input label="Window start (UTC)" type="datetime-local" value={windowStartAt} onChange={setWindowStartAt}/><Input label="Window end (UTC)" type="datetime-local" value={windowEndAt} onChange={setWindowEndAt}/><label className="grid gap-1 text-xs text-muted-foreground">Guardrail values JSON (for example {"{\"churn\":4}"})<textarea value={guardrailValuesJson} onChange={(event) => setGuardrailValuesJson(event.target.value)} className="min-h-20 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground" /></label></div></fieldset>
    </details>

    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Observation provenance and correction history ({query.data.observations.length})</summary>
      {query.data.observations.length ? <ol className="mt-2 space-y-2 text-xs">{query.data.observations.map((observation) => {
        const target = targetsById.get(observation.targetId);
        const state = supersededObservationIds.has(observation.id) ? "superseded" : observation.valid === true || observation.valid === "true" ? "current" : "invalid";
        return <li key={observation.id} className="border-l-2 border-border pl-2">
          <strong>{target ? `${target.metricKey} revision ${target.revision}` : "Unknown target revision"}</strong> · {observation.value} {observation.unit} · {state}
          <p>Population {observation.population} · source {observation.source} revision {observation.sourceRevision} · key {observation.sourceKey}</p>
          <p>Window {new Date(observation.windowStart).toLocaleString()}–{new Date(observation.windowEnd).toLocaleString()} · observed {new Date(observation.observedAt).toLocaleString()} · available {new Date(observation.availableAt).toLocaleString()} · ingested {new Date(observation.ingestedAt).toLocaleString()}</p>
          <p>Submitted by {observation.submitterType} {observation.submittedBy} via {observation.submitterSource}{observation.submitterKeyId ? ` · key ${observation.submitterKeyId}` : ""}{observation.runId ? ` · run ${observation.runId}` : ""}</p>
          {observation.supersedesId && <p>Corrects {observation.supersedesId}: {observation.correctionReason}</p>}
          {Object.keys(observation.guardrailValues).length > 0 && <p>Guardrail readings: {JSON.stringify(observation.guardrailValues)}</p>}
        </li>;
      })}</ol> : <p className="mt-2 text-xs text-muted-foreground">No observations have been recorded.</p>}
    </details>

    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Outcome check-ins and history</summary>
      <fieldset disabled={!capabilities.canCheckin} className="min-w-0">
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted-foreground">Evidence<textarea value={checkinEvidence} onChange={(event) => setCheckinEvidence(event.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"/></label>
        <Input label="Forecast value (optional)" type="number" value={forecast} onChange={setForecast}/>
        <Input label="Forecast uncertainty" value={uncertainty} onChange={setUncertainty}/>
        <label className="grid gap-1 text-xs text-muted-foreground">Corrective issue (authorized linked work only)<select value={correctiveIssueId} onChange={(event) => setCorrectiveIssueId(event.target.value)} className="rounded border border-border bg-background px-2 py-1.5 text-sm"><option value="">No corrective issue</option>{delivery.data?.map((issue) => <option key={issue.id} value={issue.id}>{issue.identifier ?? issue.id.slice(0, 8)} · {issue.title}</option>)}</select></label>
        <Input label="Next review (UTC)" type="datetime-local" value={nextReviewAt} onChange={setNextReviewAt}/>
      </div>
      <Button className="mt-2" size="sm" disabled={checkinMutation.isPending || !selectedTarget || !checkinEvidence || !uncertainty} onClick={() => checkinMutation.mutate()}>Save check-in</Button>
      {checkinMutation.error && <p role="alert" className="mt-2 text-xs text-destructive">Check-in was not saved: {checkinMutation.error.message}</p>}
      </fieldset>
      <ol className="mt-3 space-y-2 text-xs">{query.data.checkins.map((item) => {
        const target = targetsById.get(item.targetId);
        const correctiveIssue = item.correctiveIssueId ? delivery.data?.find((issue) => issue.id === item.correctiveIssueId) : undefined;
        return <li key={item.id} className="border-l-2 border-border pl-2">
          <strong>{item.health.replaceAll("_", " ")}</strong> · {target ? `${target.metricKey} revision ${target.revision}` : "Unknown target revision"} · {new Date(item.createdAt).toLocaleString()} · recorded by {item.createdBy}
          <p>Next review {new Date(item.nextReviewAt).toLocaleString()} · {item.evidence} · forecast {item.forecastValue ?? "unknown"} ({item.uncertainty})</p>
          {item.correctiveIssueId ? <Link className="text-primary underline" to={`/issues/${item.correctiveIssueId}`}>{correctiveIssue?.identifier ?? correctiveIssue?.title ?? "Open authorized corrective issue"}</Link> : <span className="text-muted-foreground">Corrective issue was not provided or is not currently visible.</span>}
        </li>;
      })}</ol>
    </details>
  </section>;
}
