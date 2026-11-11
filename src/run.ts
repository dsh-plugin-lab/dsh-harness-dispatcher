/**
 * One benchmark run: mount the harness, run the trials, always clean up.
 *
 * This is the whole experiment as a function, and it exists because there are **two ways to wait for it**
 * — the tool's own call (blocking) and a background job — while there must be only **one** way to run one.
 * Two execution paths would mean two record shapes, two cleanup orderings and, eventually, two different
 * experiments behind the same name.
 *
 * ```text
 * 1  resolve + capture the harness            no host state, no tokens
 * 2  open the run directory, write it there    evidence exists before anything runs
 * 3  mount THAT capture, audit, probe          zero model calls
 * 4  run the trials                            the only expensive part
 * 5  always unmount; on failure before 4, remove the directory
 * ```
 *
 * Step 3 before 4 is not tidiness: `register()` resolves even when the mount failed, so skipping the
 * read-back produced a run directory with an empty `trials.jsonl` — a plausible empty result, the worst
 * outcome an experiment can have.
 *
 * @module dsh-harness-dispatcher/run
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ResolvedPrompt } from './attachments.ts'
import type { FoldCollector } from './collector.ts'
import { assertFaultsReachable } from './fault.ts'
import type { Fault } from './fault.ts'
import type { FaultGate } from './gate.ts'
import type { ResolvedHarness } from './harness.ts'
import { harnessLabel, harnessRows, mountPathFor, sealedRows } from './harness.ts'
import { openRun, stimulusRecord } from './record.ts'
import type { RunHandle } from './record.ts'
import { hostToolNames, mountSubject, presetIdFor } from './subject.ts'
import type { Subject } from './subject.ts'
import { runTrial } from './trial.ts'
import type { TrialOutcome } from './trial.ts'

/** Everything one run needs. Resolved and validated by the caller, so nothing here can be rejected late. */
export interface RunRequest {
  /** Run identity, created by the caller so a background job can name the run before it starts. */
  readonly runId: string
  readonly harness: ResolvedHarness
  readonly faults: readonly Fault[]
  readonly sealed: boolean
  readonly taskId: string
  /**
   * The task as the child receives it: text, blocks, and the attachment identity the record keeps.
   *
   * Resolved by the caller **before** the run exists, so a task that cannot be built is rejected
   * while there is still nothing on disk to clean up.
   */
  readonly prompt: ResolvedPrompt
  readonly cwd: string | null
  readonly outputSchema: ObjectJsonSchema | null
  /** `0` disables the per-trial budget. */
  readonly timeoutMs: number
  readonly trials: number
}

/** One trial, as the caller sees it. */
export interface TrialSummary {
  readonly index: number
  readonly childId: string
  readonly stopReason: string
  readonly wallMs: number
  readonly toolCalls: number
  readonly toolErrors: number
  readonly observationsAvailable: boolean
  readonly timedOut: boolean
}

/** What a finished run amounts to. The same value reaches a caller and a job's `result`. */
export interface RunSummary {
  readonly runId: string
  readonly fingerprint: string
  readonly directory: string
  readonly recordPath: string
  readonly harnessPath: string
  readonly trials: number
  readonly outcomes: readonly TrialSummary[]
}

/** The runtime seams a run borrows from the plugin instance. */
export interface RunDeps {
  readonly presets: AgentPresetRegistry
  readonly subagents: SubagentRuntime
  readonly gate: FaultGate
  readonly collector: FoldCollector
  readonly outputRoot: string
}

/** Per-trial reporting, for whoever is watching a run that outlives its call. */
export interface RunObserver {
  /** One finished trial, plus how many have landed. Never throws: a watcher must not break a run. */
  onTrial?(outcome: TrialSummary, recorded: number): void
}

/**
 * One sentence a reader can act on, shared by the tool's return value and a job's result.
 * @param summary - the finished run.
 * @returns the counts and where the records are.
 */
export function summaryLine(summary: RunSummary): string {
  const completed = summary.outcomes.filter((outcome) => outcome.stopReason === 'completed').length
  return (
    `${String(summary.outcomes.length)}/${String(summary.trials)} trial(s) recorded, ` +
    `${String(completed)} completed → ${summary.recordPath}`
  )
}

/**
 * Run one benchmark, end to end.
 *
 * @param ctx - context owning the mount.
 * @param deps - registries, seams and where records live.
 * @param request - the validated stimulus and task.
 * @param parent - the calling agent, which supplies lineage and the default working directory.
 * @param signal - cancellation for the whole run.
 * @param observer - optional per-trial reporting.
 * @returns the finished run; a partial run is still returned as an exception carrying its count.
 * @throws {Error} when the harness cannot be mounted, or the run is cancelled after recording began.
 */
export async function runBench(
  ctx: Context,
  deps: RunDeps,
  request: RunRequest,
  parent: Agent,
  signal: AbortSignal,
  observer?: RunObserver,
): Promise<RunSummary> {
  const { harness, faults, runId } = request
  const stimulus = stimulusRecord(harness, faults)
  const presetId = presetIdFor(runId)

  // Capture first, then mount the capture: what is mounted is byte-identical to what the run directory
  // holds, because both come from the one string in `harness.captured.text`.
  const run = await openRun(
    deps.outputRoot,
    {
      runId,
      startedAt: Date.now(),
      stimulus,
      task: {
        taskId: request.taskId,
        prompt: request.prompt.text,
        cwd: request.cwd,
        outputSchemaRequested: request.outputSchema !== null,
        outputSchema: request.outputSchema,
        attachments: request.prompt.attachments,
      },
      note: null,
    },
    harness.captured,
  )

  let subject: Subject | undefined
  let started = false
  const outcomes: TrialSummary[] = []
  try {
    subject = await mountSubject(ctx, {
      presetId,
      label: harnessLabel(harness.captured),
      rows: [
        ...sealedRows(request.sealed ? hostToolNames(ctx) : []),
        ...harnessRows(harness.captured, mountPathFor(harness.captured, run.harnessPath)),
      ],
    })
    // Only a harness that can actually receive them may claim them in its record.
    assertFaultsReachable(faults, subject.surface.tools)
    // Observed, so it is written after the observation — never as a placeholder.
    await run.annotate(subject.surface)

    const plan = {
      runId,
      presetId,
      stimulus,
      taskId: request.taskId,
      prompt: [...request.prompt.blocks],
      cwd: request.cwd,
      outputSchema: request.outputSchema,
      timeoutMs: request.timeoutMs > 0 ? request.timeoutMs : null,
      maxDepth: harness.maxDepth,
      route: stimulus.route,
      faults,
    }

    started = true
    for (let index = 1; index <= request.trials; index += 1) {
      signal.throwIfAborted()
      outcomes.push(summarize(await runTrial(deps, plan, parent, signal, run, index)))
      observer?.onTrial?.(outcomes[outcomes.length - 1] as TrialSummary, outcomes.length)
    }

    return {
      runId,
      fingerprint: harness.fingerprint,
      directory: run.directory,
      recordPath: run.recordPath,
      harnessPath: run.harnessPath,
      trials: request.trials,
      outcomes,
    }
  } catch (error) {
    // A cancelled or failed run has usually still recorded something. Saying so is the difference
    // between "I lost my work" and "the first 3 of 10 are on disk".
    if (started && outcomes.length > 0) {
      throw new Error(
        `${describe(error)}\n${String(outcomes.length)}/${String(request.trials)} trial(s) were already ` +
          `recorded and are readable at ${run.recordPath} — the directory is kept, it is data.`,
        { cause: error },
      )
    }
    throw error
  } finally {
    await release(ctx, subject, presetId, run, started)
  }
}

/** Unmount, and throw away a directory that never reached its first trial. */
async function release(
  ctx: Context,
  subject: Subject | undefined,
  presetId: string,
  run: RunHandle,
  started: boolean,
): Promise<void> {
  if (subject !== undefined) {
    // Always unmount: a leaked preset keeps a whole Loader tree alive and makes a later mount of the
    // same id fail with a duplicate-entry error.
    await subject.dispose().catch((warning: unknown) => {
      ctx.logger.warn(
        `harness_run: failed to unmount subject preset "${presetId}": ${String(warning)}`,
      )
    })
  }
  // A run that never reached trial 1 recorded nothing, and a directory that holds no trial is
  // indistinguishable from a run whose subject did nothing. Remove it.
  if (!started) await run.discard().catch(() => undefined)
}

/** The part of a trial outcome the caller sees. */
function summarize(outcome: TrialOutcome): TrialSummary {
  return {
    index: outcome.index,
    childId: outcome.childId,
    stopReason: outcome.stopReason,
    wallMs: outcome.wallMs,
    toolCalls: outcome.toolCalls,
    toolErrors: outcome.toolErrors,
    observationsAvailable: outcome.observationsAvailable,
    timedOut: outcome.timedOut,
  }
}

/** The message of an unknown thrown value, without losing a non-Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
