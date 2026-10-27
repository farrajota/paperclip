import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAccountIdentity } from "../api/companies-query";
import {
  fetchGovernanceCalendar,
  fetchIssuePlanning,
  fetchPlanableTasks,
  saveIssuePlanning,
} from "../api/governance-planning.js";
import {
  formatInstantForDateTimeLocal,
  isIsoCalendarDate,
  isValidIanaTimezone,
  resolvePlanningDateTimeEdit,
  type GovernanceCalendarEvent,
  type GovernanceCalendarResult,
  type GovernanceCalendarSource,
  type GovernanceCalendarView,
  type GovernancePlanableTasksResult,
  type IssuePlanningInput,
  type IssuePlanningRecord,
} from "@paperclipai/shared/governance-planning";

type Props = { companyId: string };
type CalendarRange = { fromDate: string; toDate: string };
type PlanningFieldName = "earliestStart" | "plannedStart" | "plannedFinish" | "hardDeadline" | "forecastStart" | "forecastFinish";
type PlanningField = { name: PlanningFieldName; label: string };

const DAY_MS = 24 * 60 * 60 * 1_000;
const PLANNING_FIELDS: PlanningField[] = [
  { name: "earliestStart", label: "Earliest start" },
  { name: "plannedStart", label: "Planned start" },
  { name: "plannedFinish", label: "Planned finish" },
  { name: "hardDeadline", label: "Hard deadline" },
  { name: "forecastStart", label: "Forecast start" },
  { name: "forecastFinish", label: "Forecast finish" },
];
const EVENT_LABEL: Record<GovernanceCalendarEvent["eventKind"], string> = {
  earliest_start: "Earliest start",
  planned: "Planned interval",
  hard_deadline: "Hard deadline",
  forecast: "Forecast interval",
  recorded_actual: "Recorded actual",
  native_actual: "Task execution",
  native_cancelled: "Task cancellation",
  routine_schedule: "Projected routine schedule",
  routine_occurrence: "Persisted routine occurrence",
  routine_run: "Recorded routine run",
};

function dateKeyInTimezone(instant: Date, timezone: string): string | null {
  if (!Number.isFinite(instant.getTime()) || !isValidIanaTimezone(timezone)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;
  return values.year && values.month && values.day
    ? `${values.year.padStart(4, "0")}-${values.month}-${values.day}`
    : null;
}


function formatPlanningField(value: string | null, dateMode: "timed" | "all_day", timezone: string): string {
  if (!value) return "";
  if (dateMode === "all_day") {
    if (!isIsoCalendarDate(value)) throw new Error("Saved all-day values must be valid calendar dates.");
    return value;
  }
  return formatInstantForDateTimeLocal(value, timezone);
}
function displayPlanningActual(value: string, dateMode: "timed" | "all_day", timezone: string): string {
  try {
    return formatPlanningField(value, dateMode, timezone);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "timezone formatting failed";
    return `Stored value ${value} · ${reason}`;
  }
}

function addCalendarDays(date: string, days: number): string {
  const instant = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(instant + days * DAY_MS).toISOString().slice(0, 10);
}

function calendarWeekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function calendarDates(range: CalendarRange): string[] {
  const dates: string[] = [];
  for (let day = range.fromDate; day < range.toDate; day = addCalendarDays(day, 1)) dates.push(day);
  return dates;
}

function viewRange(anchor: string, view: GovernanceCalendarView): CalendarRange {
  if (view === "week") {
    const fromDate = addCalendarDays(anchor, -calendarWeekday(anchor));
    return { fromDate, toDate: addCalendarDays(fromDate, 7) };
  }
  if (view === "day") return { fromDate: anchor, toDate: addCalendarDays(anchor, 1) };
  if (view === "agenda") return { fromDate: anchor, toDate: addCalendarDays(anchor, 14) };
  const firstDate = `${anchor.slice(0, 7)}-01`;
  const firstOfMonth = new Date(`${firstDate}T00:00:00.000Z`);
  firstOfMonth.setUTCMonth(firstOfMonth.getUTCMonth() + 1, 0);
  const lastDay = firstOfMonth.getUTCDate();
  const lastDate = `${anchor.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
  const fromDate = addCalendarDays(firstDate, -calendarWeekday(firstDate));
  const toDate = addCalendarDays(lastDate, 7 - calendarWeekday(lastDate));
  return { fromDate, toDate };
}

function moveAnchor(anchor: string, view: GovernanceCalendarView, amount: number): string {
  if (view !== "month") return addCalendarDays(anchor, amount * (view === "week" ? 7 : view === "agenda" ? 14 : 1));
  const day = Number(anchor.slice(8, 10));
  const firstOfTargetMonth = new Date(`${anchor}T00:00:00.000Z`);
  firstOfTargetMonth.setUTCDate(1);
  firstOfTargetMonth.setUTCMonth(firstOfTargetMonth.getUTCMonth() + amount);
  const targetLastDay = new Date(firstOfTargetMonth.getTime());
  targetLastDay.setUTCMonth(targetLastDay.getUTCMonth() + 1, 0);
  firstOfTargetMonth.setUTCDate(Math.min(day, targetLastDay.getUTCDate()));
  return firstOfTargetMonth.toISOString().slice(0, 10);
}

function formatCalendarDate(date: string, options: Intl.DateTimeFormatOptions = {}): string {
  const noonUtc = new Date(`${date}T12:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(noonUtc);
}

function calendarEventsByDate(
  events: GovernanceCalendarEvent[],
  range: CalendarRange,
  timezone: string,
): Map<string, GovernanceCalendarEvent[]> {
  const eventsByDate = new Map<string, GovernanceCalendarEvent[]>();
  for (const date of calendarDates(range)) eventsByDate.set(date, []);
  const lastRangeDate = addCalendarDays(range.toDate, -1);
  for (const event of events) {
    let firstDate: string | null;
    let lastDate: string | null;
    if (event.dateMode === "all_day") {
      firstDate = isIsoCalendarDate(event.start) ? event.start : null;
      const endDate = event.end ?? event.start;
      lastDate = isIsoCalendarDate(endDate) ? endDate : null;
    } else {
      const startTime = Date.parse(event.start);
      const endTime = event.end ? Date.parse(event.end) : startTime;
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) continue;
      firstDate = dateKeyInTimezone(new Date(startTime), timezone);
      const endInclusive = endTime > startTime ? endTime - 1 : endTime;
      lastDate = dateKeyInTimezone(new Date(endInclusive), timezone);
    }
    if (!firstDate || !lastDate || lastDate < range.fromDate || firstDate > lastRangeDate) continue;
    const visibleStart = firstDate < range.fromDate ? range.fromDate : firstDate;
    const visibleEnd = lastDate > lastRangeDate ? lastRangeDate : lastDate;
    for (let date = visibleStart; date <= visibleEnd; date = addCalendarDays(date, 1)) {
      eventsByDate.get(date)?.push(event);
    }
  }
  return eventsByDate;
}

function eventStatus(event: GovernanceCalendarEvent): string {
  if (event.eventKind === "routine_occurrence") {
    return `Persisted occurrence · ${event.disposition ?? "unknown disposition"} · ${event.status}`;
  }
  if (event.eventKind === "routine_run") return `Recorded run · ${event.status}`;
  if (event.eventKind === "native_cancelled") return `Actual cancellation · ${event.status}`;
  if (event.actual) return `Actual · ${event.status}`;
  return `Projected · ${event.status}`;
}

function eventWhen(event: GovernanceCalendarEvent, timezone: string): string {
  if (event.dateMode === "all_day") {
    return event.end && event.end !== event.start
      ? `${event.start} – ${event.end} · all day`
      : `${event.start} · all day`;
  }
  if (!isValidIanaTimezone(timezone)) return "Time unavailable";
  const formatter = new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  const start = formatter.format(new Date(event.start));
  return event.end ? `${start} – ${formatter.format(new Date(event.end))}` : start;
}

function CalendarEventCard({
  event,
  timezone,
  compact = false,
  onEdit,
}: {
  event: GovernanceCalendarEvent;
  timezone: string;
  compact?: boolean;
  onEdit?: (issueId: string) => void;
}) {
  return <article className={`rounded border bg-background p-2 ${compact ? "text-xs" : "space-y-1 text-sm"}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <a className="font-medium underline" href={event.href}>{event.title}</a>
      {!compact && <span className="text-muted-foreground">{EVENT_LABEL[event.eventKind]}</span>}
    </div>
    <p>{eventWhen(event, timezone)}</p>
    <p className="text-muted-foreground">{eventStatus(event)}</p>
    {event.warning && <p role="status" className="text-amber-700">{event.warning}</p>}
    {event.source === "issue" && onEdit && <button type="button" className="underline" onClick={() => onEdit(event.id.split(":")[0]!)}>Edit plan</button>}
  </article>;
}

function IssuePlanningEditor({
  issueId,
  defaultTimezone,
  onClose,
  onSaved,
}: {
  issueId: string;
  defaultTimezone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [savedPlanning, setSavedPlanning] = useState<IssuePlanningRecord | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [editorDefaultTimezone] = useState(defaultTimezone);
  const [timezone, setTimezone] = useState(editorDefaultTimezone);
  const [presentationTimezone, setPresentationTimezone] = useState(editorDefaultTimezone);
  const [fieldInstants, setFieldInstants] = useState<Partial<Record<PlanningFieldName, string | null>>>({});
  const [dateMode, setDateMode] = useState<"timed" | "all_day">("timed");
  const [values, setValues] = useState<Record<PlanningFieldName, string>>({
    earliestStart: "", plannedStart: "", plannedFinish: "", hardDeadline: "", forecastStart: "", forecastFinish: "",
  });
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    fetchIssuePlanning(issueId).then((planning) => {
      if (cancelled) return;
      const mode = planning?.dateMode ?? "timed";
      const zone = planning?.dateMode === "all_day" ? planning.timezone : editorDefaultTimezone;
      const nextValues: Record<PlanningFieldName, string> = {
        earliestStart: formatPlanningField(planning?.earliestStart ?? null, mode, zone),
        plannedStart: formatPlanningField(planning?.plannedStart ?? null, mode, zone),
        plannedFinish: formatPlanningField(planning?.plannedFinish ?? null, mode, zone),
        hardDeadline: formatPlanningField(planning?.hardDeadline ?? null, mode, zone),
        forecastStart: formatPlanningField(planning?.forecastStart ?? null, mode, zone),
        forecastFinish: formatPlanningField(planning?.forecastFinish ?? null, mode, zone),
      };
      setSavedPlanning(planning);
      setRevision(planning?.revision ?? 0);
      setTimezone(zone);
      setPresentationTimezone(zone);
      setFieldInstants(Object.fromEntries(PLANNING_FIELDS.map(({ name }) => [name, planning?.[name] ?? null])));
      setDateMode(mode);
      setValues(nextValues);
      setLoaded(true);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Planning unavailable");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [issueId, editorDefaultTimezone, loadAttempt]);

  const setField = (name: PlanningFieldName, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
  };
  const handleModeChange = (nextMode: "timed" | "all_day") => {
    const hasDraftValues = Object.values(values).some((value) => value.length > 0);
    if (hasDraftValues || savedPlanning?.actualStart || savedPlanning?.actualFinish) {
      setError("Clear all planned and forecast fields before changing date meaning. Saved actual dates cannot be converted.");
      return;
    }
    setError(null);
    setDateMode(nextMode);
    setFieldInstants({});
  };
  const handleTimezoneChange = (nextTimezone: string) => {
    setTimezone(nextTimezone);
    if (!isValidIanaTimezone(nextTimezone)) return;
    if (dateMode === "all_day") {
      setPresentationTimezone(nextTimezone);
      return;
    }
    try {
      const nextValues = { ...values };
      const nextInstants = { ...fieldInstants };
      for (const { name } of PLANNING_FIELDS) {
        const instant = resolvePlanningDateTimeEdit(values[name], presentationTimezone, fieldInstants[name] ?? null);
        nextInstants[name] = instant;
        nextValues[name] = instant ? formatInstantForDateTimeLocal(instant, nextTimezone) : "";
      }
      setValues(nextValues);
      setFieldInstants(nextInstants);
      setPresentationTimezone(nextTimezone);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Resolve the draft dates before changing timezone.");
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (!loaded) throw new Error("Load the current planning revision before saving.");
      if (!isValidIanaTimezone(timezone)) throw new Error("Enter a valid IANA timezone.");
      if (presentationTimezone !== timezone) throw new Error("Resolve the draft dates before changing timezone.");
      const encode = (name: PlanningFieldName) => dateMode === "all_day"
        ? values[name] || null
        : resolvePlanningDateTimeEdit(values[name], timezone, fieldInstants[name] ?? null);
      const body: IssuePlanningInput = {
        expectedRevision: revision,
        timezone,
        dateMode,
        earliestStart: encode("earliestStart"),
        plannedStart: encode("plannedStart"),
        plannedFinish: encode("plannedFinish"),
        hardDeadline: encode("hardDeadline"),
        forecastStart: encode("forecastStart"),
        forecastFinish: encode("forecastFinish"),
        actualStart: savedPlanning?.actualStart ?? null,
        actualFinish: savedPlanning?.actualFinish ?? null,
      };
      await saveIssuePlanning(issueId, body);
      if (!active.current) return;
      onSaved();
      onClose();
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : "Planning update failed");
    } finally {
      if (active.current) setSaving(false);
    }
  };

  return <form className="space-y-4 rounded border p-4" onSubmit={handleSubmit} aria-busy={loading || saving}>
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="font-semibold">Edit task plan</h2><p className="text-sm text-muted-foreground">Calendar events are not draggable. Only these explicit fields can be changed.</p></div>
      <button type="button" onClick={onClose} disabled={saving}>Close</button>
    </div>
    {loading && <p role="status">Loading saved planning dates…</p>}
    <label className="block">Date meaning
      <select value={dateMode} onChange={(event) => handleModeChange(event.target.value as "timed" | "all_day")} disabled={loading || saving || !loaded}>
        <option value="timed">Timed</option>
        <option value="all_day">All day</option>
      </select>
    </label>
    <label className="block">Timezone (IANA)
      <input required value={timezone} onChange={(event) => handleTimezoneChange(event.target.value)} autoComplete="off" disabled={loading || saving || !loaded} />
    </label>
    <p className="text-sm text-muted-foreground">
      Timed inputs are interpreted in this timezone, never the browser timezone. New ambiguous inputs use the earlier DST fold; unchanged saved instants retain their precision and fold. Changing timezone re-presents these instants without rescheduling them.
    </p>
    <div className="grid gap-3 sm:grid-cols-2">
      {PLANNING_FIELDS.map((field) => <label className="block" key={field.name}>{field.label}
        <input
          type={dateMode === "all_day" ? "date" : "datetime-local"}
          step={dateMode === "all_day" ? undefined : 0.001}
          value={values[field.name]}
          onChange={(event) => setField(field.name, event.target.value)}
          disabled={loading || saving || !loaded}
        />
      </label>)}
    </div>
    {(savedPlanning?.actualStart || savedPlanning?.actualFinish) && <section aria-label="Recorded actual dates" className="rounded bg-muted p-3">
      <h3 className="font-medium">Recorded actual dates · read-only · {timezone}</h3>
      {savedPlanning.actualStart && <p>Actual start: {displayPlanningActual(savedPlanning.actualStart, savedPlanning.dateMode, timezone)}</p>}
      {savedPlanning.actualFinish && <p>Actual finish: {displayPlanningActual(savedPlanning.actualFinish, savedPlanning.dateMode, timezone)}</p>}
    </section>}
    {error && <div><p role="alert">{error}</p>{!loaded && <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading planning dates</button>}</div>}
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={loading || saving || !loaded}>{saving ? "Saving…" : "Save planning dates"}</button>
      <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
    </div>
  </form>;
}

function MonthCalendar({
  anchor,
  range,
  events,
  timezone,
  onEdit,
}: {
  anchor: string;
  range: CalendarRange;
  events: GovernanceCalendarEvent[];
  timezone: string;
  onEdit?: (issueId: string) => void;
}) {
  const days = calendarDates(range);
  const eventsByDate = useMemo(() => calendarEventsByDate(events, range, timezone), [events, range, timezone]);
  const weekdays = days.slice(0, 7);
  return <div className="overflow-x-auto rounded border">
    <div className="min-w-[56rem]">
      <div className="grid grid-cols-7 border-b bg-muted text-center text-sm font-medium">
        {weekdays.map((day) => <div className="p-2" key={day}>{formatCalendarDate(day, { weekday: "short" })}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const dayEvents = eventsByDate.get(day) ?? [];
          const outsideMonth = day.slice(0, 7) !== anchor.slice(0, 7);
          return <section aria-label={formatCalendarDate(day, { dateStyle: "full" })} className={`min-h-32 space-y-2 border-b border-r p-2 ${outsideMonth ? "bg-muted/40 text-muted-foreground" : ""}`} key={day}>
            <h2 className="text-sm font-medium">{formatCalendarDate(day, { day: "numeric" })}</h2>
            {dayEvents.slice(0, 4).map((event) => <CalendarEventCard key={`${event.source}:${event.id}:${event.eventKind}`} event={event} timezone={timezone} compact onEdit={onEdit} />)}
            {dayEvents.length > 4 && <p className="text-xs" role="status">{dayEvents.length - 4} more events</p>}
          </section>;
        })}
      </div>
    </div>
  </div>;
}

function WeekCalendar({
  range,
  events,
  timezone,
  onEdit,
}: {
  range: CalendarRange;
  events: GovernanceCalendarEvent[];
  timezone: string;
  onEdit?: (issueId: string) => void;
}) {
  const eventsByDate = useMemo(() => calendarEventsByDate(events, range, timezone), [events, range, timezone]);
  return <div className="overflow-x-auto rounded border">
    <div className="grid min-w-[56rem] grid-cols-7">
      {calendarDates(range).map((day) => <section aria-label={formatCalendarDate(day, { dateStyle: "full" })} className="min-h-72 space-y-2 border-r p-2" key={day}>
        <h2 className="border-b pb-2 font-medium">{formatCalendarDate(day, { weekday: "short", month: "short", day: "numeric" })}</h2>
        {(eventsByDate.get(day) ?? []).map((event) => <CalendarEventCard key={`${event.source}:${event.id}:${event.eventKind}`} event={event} timezone={timezone} onEdit={onEdit} />)}
      </section>)}
    </div>
  </div>;
}

function DayCalendar({
  day,
  events,
  timezone,
  onEdit,
}: {
  day: string;
  events: GovernanceCalendarEvent[];
  timezone: string;
  onEdit?: (issueId: string) => void;
}) {
  const dayRange = useMemo(() => ({ fromDate: day, toDate: addCalendarDays(day, 1) }), [day]);
  const eventsByDate = useMemo(() => calendarEventsByDate(events, dayRange, timezone), [events, dayRange, timezone]);
  const dayEvents = eventsByDate.get(day) ?? [];
  const allDayEvents = dayEvents.filter((event) => event.dateMode === "all_day");
  const timedEvents = dayEvents.filter((event) => event.dateMode === "timed");
  const hourByEvent = new Map<GovernanceCalendarEvent, number>();
  for (const event of timedEvents) {
    const startTime = Date.parse(event.start);
    const startDate = Number.isFinite(startTime) ? dateKeyInTimezone(new Date(startTime), timezone) : null;
    if (startDate) hourByEvent.set(event, startDate === day ? Number(formatInstantForDateTimeLocal(event.start, timezone).slice(11, 13)) : 0);
  }
  return <div className="space-y-4">
    {allDayEvents.length > 0 && <section className="space-y-2 rounded border p-3"><h2 className="font-medium">All day</h2>
      {allDayEvents.map((event) => <CalendarEventCard key={`${event.source}:${event.id}:${event.eventKind}`} event={event} timezone={timezone} onEdit={onEdit} />)}
    </section>}
    <div className="space-y-1 rounded border">
      {Array.from({ length: 24 }, (_value, hour) => {
        const hourEvents = timedEvents.filter((event) => hourByEvent.get(event) === hour);
        return <section className="grid min-h-14 grid-cols-[4rem_1fr] border-b last:border-0" key={hour}>
          <h2 className="border-r p-2 text-xs text-muted-foreground">{String(hour).padStart(2, "0")}:00</h2>
          <div className="space-y-2 p-2">{hourEvents.map((event) => <CalendarEventCard key={`${event.source}:${event.id}:${event.eventKind}`} event={event} timezone={timezone} onEdit={onEdit} />)}</div>
        </section>;
      })}
    </div>
  </div>;
}

function AgendaCalendar({
  range,
  events,
  timezone,
  onEdit,
}: {
  range: CalendarRange;
  events: GovernanceCalendarEvent[];
  timezone: string;
  onEdit?: (issueId: string) => void;
}) {
  const eventsByDate = useMemo(() => calendarEventsByDate(events, range, timezone), [events, range, timezone]);
  return <div className="space-y-3">
    {calendarDates(range).map((day) => {
      const dayEvents = eventsByDate.get(day) ?? [];
      return <section className="rounded border p-3" key={day}>
        <h2 className="mb-2 font-medium">{formatCalendarDate(day, { dateStyle: "full" })}</h2>
        {dayEvents.length === 0 ? <p className="text-sm text-muted-foreground">No events</p> : <div className="space-y-2">
          {dayEvents.map((event) => <CalendarEventCard key={`${event.source}:${event.id}:${event.eventKind}`} event={event} timezone={timezone} onEdit={onEdit} />)}
        </div>}
      </section>;
    })}
  </div>;
}

export function GovernanceCalendar({ companyId }: Props) {
  const { userId, settled, failed } = useAccountIdentity();
  if (!settled) return <main className="p-6"><p role={failed ? "alert" : "status"}>{failed ? "Account identity unavailable. Planning is hidden until the account can be resolved." : "Loading account…"}</p></main>;
  const requestScope = JSON.stringify([companyId, userId]);
  // Remount the entire owned subtree: results, task searches, editor identity,
  // loaded revisions and pending callbacks must never cross account/company.
  return <ScopedGovernanceCalendar key={requestScope} companyId={companyId} requestScope={requestScope} />;
}

function ScopedGovernanceCalendar({ companyId, requestScope }: Props & { requestScope: string }) {
  const [resultScope, setResultScope] = useState<string | null>(null);
  const [view, setView] = useState<GovernanceCalendarView>("month");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [anchor, setAnchor] = useState(() => dateKeyInTimezone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") ?? "2026-01-01");
  const [result, setResult] = useState<GovernanceCalendarResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");
  const [actualOnly, setActualOnly] = useState(false);
  const [source, setSource] = useState<GovernanceCalendarSource | "all">("all");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [taskSearch, setTaskSearch] = useState("");
  const [taskResult, setTaskResult] = useState<GovernancePlanableTasksResult | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const range = useMemo(() => viewRange(anchor, view), [anchor, view]);
  const canEditPlanning = Boolean(requestScope && resultScope === requestScope && result?.canEditPlanning);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setResultScope(null);
    if (!requestScope) return () => { cancelled = true; };
    setError(null);
    if (!isValidIanaTimezone(timezone)) {
      setError("Enter a valid IANA timezone before loading the calendar.");
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    const params = new URLSearchParams({
      from: range.fromDate,
      to: range.toDate,
      timezone,
      limit: "200",
      source,
      actualOnly: String(actualOnly),
    });
    if (projectId) params.set("projectId", projectId);
    if (assigneeAgentId) params.set("assigneeAgentId", assigneeAgentId);
    fetchGovernanceCalendar(companyId, params).then((data) => {
      if (!cancelled) { setResult(data); setResultScope(requestScope); }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Calendar unavailable");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [companyId, requestScope, range, timezone, projectId, assigneeAgentId, source, actualOnly, reloadCount]);

  const move = (amount: number) => setAnchor((current) => moveAnchor(current, view, amount));
  const loadPlanableTasks = async () => {
    if (!canEditPlanning) return;
    setSelectedTaskId("");
    setLoadingTasks(true);
    setTaskError(null);
    setTaskResult(null);
    const params = new URLSearchParams({ limit: "100" });
    if (taskSearch.trim()) params.set("query", taskSearch.trim());
    if (projectId) params.set("projectId", projectId);
    if (assigneeAgentId) params.set("assigneeAgentId", assigneeAgentId);
    try {
      const tasks = await fetchPlanableTasks(companyId, params);
      if (!active.current) return;
      setTaskResult(tasks);
      setSelectedTaskId(tasks.tasks[0]?.id ?? "");
    } catch (reason) {
      if (active.current) setTaskError(reason instanceof Error ? reason.message : "Task selector unavailable");
    } finally {
      if (active.current) setLoadingTasks(false);
    }
  };
  const openPlanEditor = canEditPlanning ? (issueId: string) => setSelectedIssueId(issueId) : undefined;
  const today = () => {
    if (!isValidIanaTimezone(timezone)) {
      setError("Enter a valid IANA timezone before navigating to today.");
      return;
    }
    const currentDate = dateKeyInTimezone(new Date(), timezone);
    if (currentDate) setAnchor(currentDate);
  };
  const rangeEndInclusive = addCalendarDays(range.toDate, -1);

  return <main className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6" aria-busy={loading}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Plan</h1>
        <p className="text-sm text-muted-foreground">Prospective schedules and recorded work. Navigation and filters are read-only; calendar events cannot be dragged to reschedule.</p>
      </div>
      <nav aria-label="Calendar period navigation" className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label={`Previous ${view}`} onClick={() => move(-1)}>Previous</button>
        <label>Go to date <input type="date" value={anchor} onChange={(event) => { if (event.target.value) setAnchor(event.target.value); }} /></label>
        <button type="button" aria-label={`Next ${view}`} onClick={() => move(1)}>Next</button>
        <button type="button" onClick={today}>Today</button>
      </nav>
    </header>

    <section className="flex flex-wrap items-end gap-3" aria-label="Calendar filters">
      <label>View
        <select value={view} onChange={(event) => setView(event.target.value as GovernanceCalendarView)}>
          <option value="month">Month</option><option value="week">Week</option><option value="day">Day</option><option value="agenda">Agenda</option>
        </select>
      </label>
      <label>View timezone (IANA)
        <input value={timezone} onChange={(event) => setTimezone(event.target.value)} autoComplete="off" />
      </label>
      <label>Project ID
        <input value={projectId} onChange={(event) => setProjectId(event.target.value)} />
      </label>
      <label>Agent ID
        <input value={assigneeAgentId} onChange={(event) => setAssigneeAgentId(event.target.value)} />
      </label>
      <label>Source
        <select value={source} onChange={(event) => setSource(event.target.value as GovernanceCalendarSource | "all")}>
          <option value="all">All sources</option><option value="issue">Tasks</option><option value="routine">Routines</option><option value="run">Runs</option>
        </select>
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={actualOnly} onChange={(event) => setActualOnly(event.target.checked)} /> Actual records only</label>
    </section>

    <p className="text-sm text-muted-foreground">{formatCalendarDate(range.fromDate, { dateStyle: "medium" })} – {formatCalendarDate(rangeEndInclusive, { dateStyle: "medium" })} · {timezone}</p>
    {loading && <p role="status">Loading calendar…</p>}
    {error && <div role="alert" className="rounded border border-destructive p-3"><p>{error}</p><button type="button" onClick={() => setReloadCount((count) => count + 1)}>Retry calendar</button></div>}
    {result?.truncated && <p role="status">Showing the requested cap of authorized events; narrow the range or filters for more.</p>}
    {result?.incomplete && <p role="status">The bounded projection reached a safe source or recurrence cap; this range may be incomplete.</p>}
    {result?.warnings.map((warning) => <p role="status" className="rounded border p-2" key={warning}>{warning}</p>)}
    {result && !error && (view === "month"
      ? <MonthCalendar anchor={anchor} range={range} events={result.events} timezone={timezone} onEdit={openPlanEditor} />
      : view === "week"
        ? <WeekCalendar range={range} events={result.events} timezone={timezone} onEdit={openPlanEditor} />
        : view === "day"
          ? <DayCalendar day={anchor} events={result.events} timezone={timezone} onEdit={openPlanEditor} />
          : <AgendaCalendar range={range} events={result.events} timezone={timezone} onEdit={openPlanEditor} />)}
    {result && result.events.length === 0 && !loading && <p className="rounded border p-4 text-sm">No calendar events in this range.</p>}

    {canEditPlanning && <>
    <section className="space-y-3 rounded border p-4" aria-label="Plan an unscheduled task">
      <div><h2 className="font-semibold">Plan an unscheduled task</h2><p className="text-sm text-muted-foreground">Search the tasks you are authorized to read, then set planning dates without creating or dispatching work.</p></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1">Task search
          <input value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} maxLength={100} />
        </label>
        <button type="button" onClick={loadPlanableTasks} disabled={loadingTasks}>{loadingTasks ? "Searching…" : "Find unplanned tasks"}</button>
      </div>
      {taskError && <p role="alert">{taskError}</p>}
      {taskResult && <>
        <label className="block">Authorized unplanned task
          <select value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)}>
            {taskResult.tasks.length === 0 && <option value="">No matching tasks</option>}
            {taskResult.tasks.map((task) => <option key={task.id} value={task.id}>{task.identifier ? `${task.identifier} · ` : ""}{task.title} · {task.status}</option>)}
          </select>
        </label>
        {(taskResult.truncated || taskResult.incomplete) && <p role="status">The authorized task selector reached a safe result cap; refine the search.</p>}
        <button type="button" disabled={!selectedTaskId} onClick={() => openPlanEditor?.(selectedTaskId)}>Plan selected task</button>
      </>}
    </section>
    </>}

    {canEditPlanning && selectedIssueId && <IssuePlanningEditor
      key={selectedIssueId}
      issueId={selectedIssueId}
      defaultTimezone={timezone}
      onClose={() => setSelectedIssueId(null)}
      onSaved={() => setReloadCount((count) => count + 1)}
    />}
  </main>;
}
