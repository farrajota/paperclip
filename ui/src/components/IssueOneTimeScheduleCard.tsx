import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type {
  IssueOneTimeSchedule,
  IssueOneTimeScheduleStatus,
} from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { queryKeys } from "../lib/queryKeys";

const SCHEDULE_STATUS_LABELS: Record<IssueOneTimeScheduleStatus, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  waiting: "Waiting for execution",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function displayScheduleError(error: unknown) {
  return error instanceof Error ? error.message : "The schedule could not be updated.";
}

function mayReplaceSchedule(schedule: IssueOneTimeSchedule | null) {
  return !schedule || ["completed", "failed", "cancelled"].includes(schedule.status);
}

export function IssueOneTimeScheduleCard({
  issueId,
  canSchedule,
}: {
  issueId: string;
  canSchedule: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.issues.oneTimeSchedule(issueId);
  const scheduleQuery = useQuery({
    queryKey,
    queryFn: () => issuesApi.getOneTimeSchedule(issueId),
  });
  const createSchedule = useMutation({
    mutationFn: (input: { timestamp: string; timeZone: string }) =>
      issuesApi.createOneTimeSchedule(issueId, input),
    onSuccess: (schedule) => queryClient.setQueryData(queryKey, schedule),
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });
  const cancelSchedule = useMutation({
    mutationFn: (scheduleId: string) =>
      issuesApi.cancelOneTimeSchedule(issueId, scheduleId),
    onSuccess: (schedule) => queryClient.setQueryData(queryKey, schedule),
    onError: () => queryClient.invalidateQueries({ queryKey }),
  });

  const [dueLocalTime, setDueLocalTime] = useState("");
  const [utcOffset, setUtcOffset] = useState("+00:00");
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const schedule = scheduleQuery.data ?? null;
  const dueAtIso = schedule ? new Date(schedule.dueAt).toISOString() : undefined;
  const showCreate = canSchedule && mayReplaceSchedule(schedule);
  const updateError = createSchedule.error ?? cancelSchedule.error;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createSchedule.mutate({
      timestamp: `${dueLocalTime}${utcOffset}`,
      timeZone: timeZone.trim(),
    });
  }

  if (scheduleQuery.isLoading) {
    return (
      <section className="mb-3 rounded-lg border px-3 py-3" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading one-time schedule…</p>
      </section>
    );
  }

  return (
    <section
      className="mb-3 rounded-lg border px-3 py-3"
      data-testid="issue-one-time-schedule-card"
      aria-label="One-time run schedule"
    >
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">One-time run</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Schedule an existing issue without starting a run now. When due, the native scheduler applies its normal permission, pause, budget, checkout, and concurrency rules.
          </p>
        </div>

        {scheduleQuery.isError ? (
          <div role="alert" className="text-sm text-destructive">
            {displayScheduleError(scheduleQuery.error)}
          </div>
        ) : null}

        {schedule ? (
          <div data-testid="one-time-schedule-status" className="rounded-md bg-muted/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span>{SCHEDULE_STATUS_LABELS[schedule.status]}</span>
              {schedule.runId ? (
                <span className="font-mono text-xs text-muted-foreground">
                  Run {schedule.runId.slice(0, 8)}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              <time dateTime={dueAtIso}>{dueAtIso}</time>
              {" · "}
              {schedule.timeZone}
            </p>
            {schedule.error || schedule.cancellationReason ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {schedule.error ?? schedule.cancellationReason}
              </p>
            ) : null}
            {schedule.status === "scheduled" && !schedule.wakeupRequestId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                data-testid="one-time-schedule-cancel"
                disabled={cancelSchedule.isPending}
                onClick={() => cancelSchedule.mutate(schedule.id)}
              >
                {cancelSchedule.isPending ? "Cancelling…" : "Cancel schedule"}
              </Button>
            ) : null}
          </div>
        ) : null}

        {showCreate ? (
          <form onSubmit={submit} className="grid min-w-0 gap-2">
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
              Due date and time
              <input
                name="dueLocalTime"
                type="datetime-local"
                required
                value={dueLocalTime}
                onChange={(event) => setDueLocalTime(event.target.value)}
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
              UTC offset for that time
              <input
                name="utcOffset"
                type="text"
                required
                value={utcOffset}
                onChange={(event) => setUtcOffset(event.target.value)}
                placeholder="-04:00"
                pattern="(?:Z|[+-](?:0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])"
                title="Enter Z or an offset such as -04:00"
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
              IANA time zone
              <input
                name="timeZone"
                type="text"
                required
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                placeholder="America/New_York"
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm text-foreground"
              />
            </label>
            {updateError ? (
              <div role="alert" className="text-sm text-destructive">
                {displayScheduleError(updateError)}
              </div>
            ) : null}
            <div>
              <Button
                type="submit"
                size="sm"
                data-testid="one-time-schedule-create"
                disabled={createSchedule.isPending}
              >
                {createSchedule.isPending ? "Scheduling…" : "Schedule run"}
              </Button>
            </div>
          </form>
        ) : !canSchedule && !schedule ? (
          <p className="text-xs text-muted-foreground">
            Assign an eligible agent to a visible, open issue before scheduling a run.
          </p>
        ) : null}

        {updateError && !showCreate ? (
          <div role="alert" className="text-sm text-destructive">
            {displayScheduleError(updateError)}
          </div>
        ) : null}
      </div>
    </section>
  );
}
