import { z } from "zod";

const ianaTimezone = z.string().min(1).refine((timezone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}, "Must be a valid IANA timezone");

export const outcomeDirectionSchema = z.enum(["increase", "decrease", "range"]);
export const outcomeAggregationSchema = z.enum(["latest", "sum"]);
export const outcomeGuardrailSchema = z.object({ name: z.string().min(1), direction: z.enum(["min", "max"]), threshold: z.number().finite() });
export const outcomeTrajectorySchema = z.array(z.object({ at: z.string().datetime(), value: z.number().finite() }));

export const createOutcomeTargetSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  period: z.object({ label: z.string().min(1), timezone: ianaTimezone, intervalStart: z.string().datetime(), intervalEnd: z.string().datetime(), lifecycle: z.enum(["draft", "active", "closed"]).default("active") }),
  metricKey: z.string().min(1), kind: z.enum(["number", "percentage", "currency", "duration", "count"]),
  unit: z.string().min(1), direction: outcomeDirectionSchema, aggregation: outcomeAggregationSchema,
  population: z.string().min(1), source: z.string().min(1), queryVersion: z.string().min(1), freshnessHours: z.number().int().positive(), maturityHours: z.number().int().positive().default(24),
  baselineValue: z.number().finite().nullable().optional(), targetValue: z.number().finite().nullable().optional(),
  rangeMin: z.number().finite().nullable().optional(), rangeMax: z.number().finite().nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(), guardrails: z.array(outcomeGuardrailSchema).default([]), trajectory: outcomeTrajectorySchema.default([]),
}).superRefine((v, ctx) => {
  if (Date.parse(v.period.intervalStart) >= Date.parse(v.period.intervalEnd)) ctx.addIssue({ code: "custom", path: ["period", "intervalEnd"], message: "Period end must be after its start" });
  if (v.direction === "range" && (v.rangeMin == null || v.rangeMax == null || v.rangeMin > v.rangeMax)) ctx.addIssue({ code: "custom", path: ["rangeMin"], message: "Range metrics require ordered lower and upper bounds" });
  if (v.direction !== "range" && v.targetValue == null) ctx.addIssue({ code: "custom", path: ["targetValue"], message: "A target value is required" });
  if (v.direction === "increase" && v.baselineValue != null && v.targetValue != null && v.targetValue < v.baselineValue) ctx.addIssue({ code: "custom", path: ["targetValue"], message: "Increasing targets cannot be below baseline" });
  if (v.direction === "decrease" && v.baselineValue != null && v.targetValue != null && v.targetValue > v.baselineValue) ctx.addIssue({ code: "custom", path: ["targetValue"], message: "Decreasing targets cannot exceed baseline" });
});
export type CreateOutcomeTarget = z.infer<typeof createOutcomeTargetSchema>;

export const createOutcomeObservationSchema = z.object({
  targetId: z.string().uuid(), source: z.string().min(1), sourceRevision: z.string().min(1), sourceKey: z.string().min(1),
  value: z.number().finite(), unit: z.string().min(1), population: z.string().min(1),
  windowStart: z.string().datetime(), windowEnd: z.string().datetime(), observedAt: z.string().datetime(), availableAt: z.string().datetime(),
  guardrailValues: z.record(z.string(), z.number().finite()).default({}),
}).superRefine((v, ctx) => {
  if (Date.parse(v.windowStart) >= Date.parse(v.windowEnd)) ctx.addIssue({ code: "custom", path: ["windowEnd"], message: "Observation window end must be after start" });
  if (Date.parse(v.availableAt) < Date.parse(v.observedAt)) ctx.addIssue({ code: "custom", path: ["availableAt"], message: "Availability cannot precede observation time" });
});
export const correctOutcomeObservationSchema = createOutcomeObservationSchema.extend({ supersedesId: z.string().uuid(), correctionReason: z.string().trim().min(1) });
export const createOutcomeCheckinSchema = z.object({ targetId: z.string().uuid(), health: z.enum(["on_track", "at_risk", "off_track", "unknown"]), evidence: z.string().min(1), forecastValue: z.number().finite().nullable().optional(), uncertainty: z.string().min(1), correctiveIssueId: z.string().uuid().nullable().optional(), nextReviewAt: z.string().datetime() });

export type OutcomeDirection = z.infer<typeof outcomeDirectionSchema>;
export type OutcomeAggregation = z.infer<typeof outcomeAggregationSchema>;
export type OutcomeGuardrail = z.infer<typeof outcomeGuardrailSchema>;
export type OutcomeTargetInput = z.infer<typeof createOutcomeTargetSchema>;
export type OutcomeObservationInput = z.infer<typeof createOutcomeObservationSchema>;
export type CreateOutcomeCheckin = z.infer<typeof createOutcomeCheckinSchema>;

export type OutcomeCapabilities = {
  canApproveTargets: boolean;
  canCheckin: boolean;
  observationTargetIds: string[];
  explanation: string;
};
