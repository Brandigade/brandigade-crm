import { adminClient } from "./supabase.js";

// The background job queue (public.job_queue). Enqueueing with a dedupe key
// is idempotent: the same notification or backfill can only be queued once.
// Workers claim jobs with a lease (claim_jobs), so two scheduler runs that
// overlap never process the same job at the same time, and a crashed run's
// jobs become claimable again when the lease expires.

export interface Job<P = any> {
  id: number;
  kind: string;
  payload: P;
  workspace_id: string | null;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string;
}

export interface JobContext {
  /** Epoch ms by which the handler should finish. */
  deadline: number;
}

/** Return "skipped" (with a reason) when a job no longer applies. */
export type JobOutcome = void | { status: "done" | "skipped"; result?: unknown };
export type JobHandler = (job: Job, ctx: JobContext) => Promise<JobOutcome>;

/** Throw to stop retrying a job (bad input, record gone, permanent provider refusal). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Throw to retry later at a specific time (e.g. provider rate limit). */
export class RetryJobLater extends Error {
  constructor(public readonly delayMs: number, message = "Retry later") {
    super(message);
    this.name = "RetryJobLater";
  }
}

export async function enqueueJob(
  kind: string,
  payload: Record<string, unknown>,
  opts: { dedupeKey?: string; runAfter?: Date; workspaceId?: string; maxAttempts?: number } = {},
): Promise<number | null> {
  const { data, error } = await adminClient().rpc("enqueue_job", {
    p_kind: kind,
    p_payload: payload,
    p_dedupe_key: opts.dedupeKey ?? null,
    p_run_after: (opts.runAfter ?? new Date()).toISOString(),
    p_workspace: opts.workspaceId ?? null,
    p_max_attempts: opts.maxAttempts ?? 6,
  });
  if (error) throw error;
  return (data as number | null) ?? null;
}

/** Exponential backoff: 30 s, 1 min, 2 min, 4 min ... capped at 1 h. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export interface RunJobsSummary {
  claimed: number;
  done: number;
  skipped: number;
  retried: number;
  dead: number;
}

/**
 * Claims and runs ready jobs of the kinds in `handlers` until the deadline.
 * Every job ends as done, skipped, retry (with backoff) or dead.
 */
export async function runJobs(
  handlers: Record<string, JobHandler>,
  opts: { deadline: number; batchSize?: number; leaseSeconds?: number },
): Promise<RunJobsSummary> {
  const kinds = Object.keys(handlers);
  const summary: RunJobsSummary = { claimed: 0, done: 0, skipped: 0, retried: 0, dead: 0 };
  if (!kinds.length) return summary;
  const db = adminClient();
  const batchSize = opts.batchSize ?? 10;
  const lease = opts.leaseSeconds ?? 120;

  while (Date.now() < opts.deadline - 5_000) {
    const { data, error } = await db.rpc("claim_jobs", { p_kinds: kinds, p_limit: batchSize, p_lease_seconds: lease });
    if (error) throw error;
    const jobs = (data || []) as Job[];
    if (!jobs.length) break;
    summary.claimed += jobs.length;
    for (const job of jobs) {
      const handler = handlers[job.kind];
      try {
        const outcome = await handler(job, { deadline: opts.deadline });
        const status = outcome && outcome.status === "skipped" ? "skipped" : "done";
        await db
          .from("job_queue")
          .update({ status, result: outcome && "result" in outcome ? outcome.result ?? null : null, finished_at: new Date().toISOString(), locked_until: null, last_error: null })
          .eq("id", job.id);
        summary[status]++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const permanent = err instanceof PermanentJobError;
        const exhausted = job.attempts >= job.max_attempts;
        if (permanent || exhausted) {
          console.error(`Job ${job.kind} #${job.id} failed permanently:`, message);
          await db
            .from("job_queue")
            .update({ status: "dead", last_error: message.slice(0, 2000), finished_at: new Date().toISOString(), locked_until: null })
            .eq("id", job.id);
          summary.dead++;
        } else {
          const delay = err instanceof RetryJobLater ? err.delayMs : backoffMs(job.attempts);
          console.warn(`Job ${job.kind} #${job.id} will retry in ${Math.round(delay / 1000)}s:`, message);
          await db
            .from("job_queue")
            .update({ status: "retry", last_error: message.slice(0, 2000), run_after: new Date(Date.now() + delay).toISOString(), locked_until: null })
            .eq("id", job.id);
          summary.retried++;
        }
      }
      if (Date.now() >= opts.deadline - 5_000) break;
    }
  }
  return summary;
}
