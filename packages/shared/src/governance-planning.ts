import { z } from "zod";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, yearValue, monthValue, dayValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isOffsetQualifiedInstant(value: string): boolean {
  const match = ISO_INSTANT.exec(value);
  if (!match || !isIsoCalendarDate(match[1]!)) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offset = match[5]!;
  if (hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return false;
  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

export function isValidIanaTimezone(value: string): boolean {
  if (!value.trim() || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

type ZonedDateTimeParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function utcWallClockTimestamp(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, 0);
  return instant.getTime();
}

function zonedDateTimePartsAt(instant: Date, timezone: string): ZonedDateTimeParts {
  if (!Number.isFinite(instant.getTime()) || !isValidIanaTimezone(timezone)) {
    throw new Error("Enter a valid time and IANA timezone.");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values: Record<string, number> = {};
  for (const part of parts) values[part.type] = Number(part.value);
  if (!Number.isFinite(values.year) || !Number.isFinite(values.month) || !Number.isFinite(values.day)
    || !Number.isFinite(values.hour) || !Number.isFinite(values.minute) || !Number.isFinite(values.second)) {
    throw new Error("The selected timezone could not format this date.");
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

export function formatInstantForDateTimeLocal(value: string, timezone: string): string {
  if (!isOffsetQualifiedInstant(value)) throw new Error("Saved timed values must include a UTC offset.");
  const instant = new Date(value);
  const parts = zonedDateTimePartsAt(instant, timezone);
  const milliseconds = instant.getUTCMilliseconds();
  const seconds = parts.second || milliseconds ? `:${String(parts.second).padStart(2, "0")}${milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : ""}` : "";
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}${seconds}`;
}

export function resolveDateTimeLocalInput(value: string, timezone: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match || !isIsoCalendarDate(match[1]!)) throw new Error("Enter a valid local date and time.");
  if (!isValidIanaTimezone(timezone)) throw new Error("Enter a valid IANA timezone.");
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  const milliseconds = Number((match[5] ?? "").padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) throw new Error("Enter a valid local date and time.");
  const [year, month, day] = match[1]!.split("-").map(Number);
  const wallClock = utcWallClockTimestamp(year!, month!, day!, hour, minute, second) + milliseconds;
  const offsets = new Set<number>();
  for (let offsetHours = -36; offsetHours <= 36; offsetHours += 6) {
    const probe = wallClock + offsetHours * 60 * 60 * 1_000;
    const probeMinute = Math.floor(probe / (60 * 1_000)) * (60 * 1_000);
    const parts = zonedDateTimePartsAt(new Date(probeMinute), timezone);
    const formattedWallClock = utcWallClockTimestamp(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    offsets.add(formattedWallClock - probeMinute);
  }
  const candidates: number[] = [];
  for (const offset of offsets) {
    const candidate = wallClock - offset;
    const parts = zonedDateTimePartsAt(new Date(candidate), timezone);
    if (parts.year === year && parts.month === month && parts.day === day
      && parts.hour === hour && parts.minute === minute && parts.second === second) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    throw new Error("This local time does not exist because of a daylight-saving-time transition.");
  }
  return new Date(Math.min(...candidates)).toISOString();
}

export function resolvePlanningDateTimeEdit(value: string, timezone: string, savedValue: string | null): string | null {
  if (!value) return null;
  // Wall-clock text alone cannot identify a saved later DST fold, nor its full stored precision.
  if (savedValue && value === formatInstantForDateTimeLocal(savedValue, timezone)) return savedValue;
  return resolveDateTimeLocalInput(value, timezone);
}

const dateValue = z.string().refine(
  (value) => isIsoCalendarDate(value) || isOffsetQualifiedInstant(value),
  "Expected an ISO calendar date or timezone-qualified instant",
);
const nullableDate = dateValue.nullable().optional();
const timezone = z.string().refine(isValidIanaTimezone, "Expected a valid IANA timezone");

export const issuePlanningInputSchema = z.object({
  earliestStart: nullableDate,
  plannedStart: nullableDate,
  plannedFinish: nullableDate,
  hardDeadline: nullableDate,
  forecastStart: nullableDate,
  forecastFinish: nullableDate,
  actualStart: nullableDate,
  actualFinish: nullableDate,
  dateMode: z.enum(["timed", "all_day"]).default("timed"),
  timezone,
  expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  const fields = ["earliestStart", "plannedStart", "plannedFinish", "hardDeadline", "forecastStart", "forecastFinish", "actualStart", "actualFinish"] as const;
  for (const field of fields) {
    const date = value[field];
    if (typeof date !== "string") continue;
    const valid = value.dateMode === "all_day" ? isIsoCalendarDate(date) : isOffsetQualifiedInstant(date);
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: value.dateMode === "all_day"
          ? "All-day values must be valid calendar dates"
          : "Timed values must be valid instants with an explicit UTC offset",
      });
    }
  }
  const intervals = [
    { start: value.plannedStart, finish: value.plannedFinish, finishField: "plannedFinish", label: "Planned" },
    { start: value.forecastStart, finish: value.forecastFinish, finishField: "forecastFinish", label: "Forecast" },
    { start: value.actualStart, finish: value.actualFinish, finishField: "actualFinish", label: "Actual" },
  ] as const;
  for (const interval of intervals) {
    if (typeof interval.start !== "string" || typeof interval.finish !== "string") continue;
    const startsLater = value.dateMode === "all_day"
      ? interval.start > interval.finish
      : Date.parse(interval.start) > Date.parse(interval.finish);
    if (startsLater) {
      ctx.addIssue({
        code: "custom",
        path: [interval.finishField],
        message: `${interval.label} finish must not precede ${interval.label.toLowerCase()} start`,
      });
    }
  }
});

export type IssuePlanningInput = z.infer<typeof issuePlanningInputSchema>;
export type IssuePlanningDateMode = IssuePlanningInput["dateMode"];
export type IssuePlanningGate = {
  eligible: boolean;
  reason: "ready" | "earliest_start" | "unknown";
  earliestStart: string | null;
  revision: number | null;
};

export interface IssuePlanningRecord {
  issueId: string;
  companyId: string;
  earliestStart: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  hardDeadline: string | null;
  forecastStart: string | null;
  forecastFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  dateMode: IssuePlanningDateMode;
  timezone: string;
  revision: number;
  updatedAt: string;
}

function calendarDateInZone(date: Date, timezone: string): string | null {
  if (!Number.isFinite(date.getTime()) || !isValidIanaTimezone(timezone)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  return year && month && day ? `${year.padStart(4, "0")}-${month}-${day}` : null;
}

export function isIssueStartEligible(
  earliestStart: string | null | undefined,
  now: Date,
  timezone = "UTC",
  dateMode: IssuePlanningDateMode = "timed",
): boolean {
  if (!earliestStart) return true;
  if (dateMode === "all_day") {
    const today = calendarDateInZone(now, timezone);
    return isIsoCalendarDate(earliestStart) && today !== null && today >= earliestStart;
  }
  if (!isOffsetQualifiedInstant(earliestStart) || !Number.isFinite(now.getTime())) return false;
  return Date.parse(earliestStart) <= now.getTime();
}

export type GovernanceCalendarView = "month" | "week" | "day" | "agenda";
export type GovernanceCalendarSource = "issue" | "routine" | "run";
export type GovernanceCalendarEventKind =
  | "earliest_start"
  | "planned"
  | "hard_deadline"
  | "forecast"
  | "recorded_actual"
  | "native_actual"
  | "native_cancelled"
  | "routine_schedule"
  | "routine_occurrence"
  | "routine_run";

export type GovernanceCalendarEvent = {
  id: string;
  source: GovernanceCalendarSource;
  eventKind: GovernanceCalendarEventKind;
  title: string;
  href: string;
  start: string;
  end: string | null;
  actual: boolean;
  status: string;
  dateMode: IssuePlanningDateMode;
  timezone: string;
  disposition?: string;
  warning?: string;
};

export type GovernanceCalendarResult = {
  /** Server-derived capability for the current request, absent outside the HTTP read model. */
  canEditPlanning?: boolean;
  events: GovernanceCalendarEvent[];
  truncated: boolean;
  incomplete: boolean;
  warnings: string[];
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  timezone: string;
};

export type GovernancePlanableTask = { id: string; identifier: string | null; title: string; status: string };
export type GovernancePlanableTasksResult = { tasks: GovernancePlanableTask[]; truncated: boolean; incomplete: boolean };
