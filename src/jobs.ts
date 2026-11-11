/**
 * The background-job seam, as this plugin needs it.
 *
 * Declared structurally rather than imported for the same reason [subject.ts](subject.ts) does it: a
 * profile that loads no `dsh-jobs` must still get a working bench, so this cannot be a peer dependency.
 * The shapes are the host's (`JobSpec` / `JobHooks` / `JobOutcome`), narrowed to the part used here.
 *
 * Why a job at all: `harness_run` blocks the caller's turn for as long as the trials take, and the host
 * offers exactly one sanctioned way out — the same one `pwsh` and `workflow` take. `run_in_background`
 * registers the work with `ctx.jobs` and returns an id; the registry routes the settlement, and
 * `dsh-tool-jobs` turns that into a completion notice (injected into a busy step, or a wake-up turn for
 * an idle owner). Nothing here delivers a notification: that is the runtime's job, and reaching for it
 * ourselves would be hooking into a loop we do not own.
 *
 * @module dsh-harness-dispatcher/jobs
 */

/** How a job ended. Mirrors the host's `JobOutcome.status`. */
export type JobStatus = 'completed' | 'killed' | 'failed'

/** What the registry needs back from a producer's completion. */
export interface JobOutcome {
  readonly status: JobStatus
  /** Terminal reason, rendered into the notice's status line. */
  readonly detail?: string
  /**
   * The value the model's first read after settlement receives, exactly once.
   *
   * The run's own sentence goes here: a background run that says nothing about how many trials landed
   * would leave the model reading a bare `completed`.
   */
  readonly result?: string
}

/** The producer face of one registered job. */
export interface JobHandle {
  readonly id: string
  /**
   * Append a line to the job's output ring, which `job_output` reads.
   *
   * Leave `channel` unset for anything the model should read. The registry's `log` channel is producer
   * narration for observers and is filtered out of the model's consuming read — measured: per-trial lines
   * written with `channel: 'log'` never appeared in `job_output`, while the run's own `updateProgress`
   * line did.
   */
  append(text: string, options?: { readonly channel?: 'stdout' | 'stderr' | 'log' }): void
  /** Replace the live progress line. */
  updateProgress(line: string): void
}

/** What a producer returns from its starter: how to stop it, and when it has stopped. */
export interface JobHooks {
  cancel(reason?: string): void
  /** Must not reject; the registry converts a rejection to `failed`. */
  readonly done: Promise<JobOutcome>
}

/** One registration. */
export interface JobSpec {
  /** Producer kind, also the id prefix (`harness-…`). */
  readonly kind: string
  readonly label: string
  /** The owning Session; its disposal cancels the job. */
  readonly owner?: string
  readonly toolCall?: { readonly callId: string; readonly rootCallId: string }
  /** Synchronous: start the work, return the hooks. A throw leaves nothing registered. */
  run(job: JobHandle): JobHooks
}

/** The registry, narrowed to what this plugin calls. */
export interface JobRegistry {
  start(spec: JobSpec): string
}

/**
 * Map a run's own outcome onto the job vocabulary.
 *
 * Pure, so the three cases are testable without a host: a finished run is `completed`, a run stopped by
 * the job is `killed`, and anything thrown that was not a cancellation is `failed` — a distinction the
 * reader needs, because "somebody killed it" and "it broke" call for different next steps.
 *
 * `detail` is the status line, so it gets **one line**: a multi-line message there pushed a whole
 * paragraph into `[status: killed, …]`. The full text travels in `result`, which is a body the model reads
 * rather than a label. A killed job reports no detail at all — the registry merges the kill reason the
 * caller supplied, and repeating it here printed the reason twice.
 *
 * `stopped` is consulted even when nothing threw, because a stop is not an error: the run returns a
 * partial summary, and a job whose own cancellation produced it must settle as `killed` rather than as
 * `completed` — otherwise a killed job reads as a finished one with fewer trials than it asked for.
 * @param stopped - whether the job's own cancellation is what ended the run.
 * @param error - the thrown value, when the run threw.
 * @param result - what the model should read on its first read after settlement.
 * @returns the outcome the registry records.
 */
export function jobOutcomeOf(stopped: boolean, error: unknown, result: string): JobOutcome {
  if (error === undefined) return { status: stopped ? 'killed' : 'completed', result }
  if (stopped) return { status: 'killed', result }
  const detail = firstLine(error instanceof Error ? error.message : String(error))
  return detail === '' ? { status: 'failed', result } : { status: 'failed', detail, result }
}

/** The part of a message that belongs on a status line. */
function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}
