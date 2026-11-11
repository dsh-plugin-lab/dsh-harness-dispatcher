/**
 * One trial: start a subject, arm the two per-session seams, wait, record.
 *
 * Both seams are armed **before** the result is awaited and disarmed **after** it is read. A subject
 * that finishes in one turn emits its events on the way to resolving, so arming late loses the earliest
 * ones and understates the trace.
 *
 * A subject that errors, refuses, hits its token ceiling or is aborted produces **a record**, not an
 * exception. Only a fault in this plugin throws (AGENTS.md discipline 4).
 *
 * Who stops the subject: **a stop does**. `startActivation`'s signal does not, so {@link runTrial} wires
 * the fused signal to `dispose()`; and a stop aimed at one trial from its own session is the host's
 * `interrupt`, which cancels that child's turn and leaves the run going.
 *
 * @module dsh-harness-dispatcher/trial
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { onceAborted } from './abort.ts'
import type { FoldCollector } from './collector.ts'
import type { Fault } from './fault.ts'
import type { FaultGate } from './gate.ts'
import type { RunHandle, StimulusRecord, TrialRecord, TrialStopReason } from './record.ts'
import { contentBlocksOf } from './text.ts'

/** Everything one trial needs beyond its index. */
export interface TrialPlan {
  readonly runId: string
  readonly presetId: string
  readonly stimulus: StimulusRecord
  readonly taskId: string
  readonly prompt: readonly ContentBlock[]
  readonly cwd: string | null
  readonly outputSchema: ObjectJsonSchema | null
  readonly timeoutMs: number | null
  readonly maxDepth: number
  readonly route: { readonly provider: string; readonly model: string } | null
  readonly faults: readonly Fault[]
}

/** What one trial produced, for the tool's return value. */
export interface TrialOutcome {
  readonly index: number
  readonly childId: string
  readonly stopReason: TrialStopReason
  readonly wallMs: number
  readonly toolCalls: number
  readonly toolErrors: number
  readonly observationsAvailable: boolean
  readonly timedOut: boolean
}

/** The runtime seams a trial borrows from the plugin instance. */
export interface TrialDeps {
  readonly subagents: SubagentRuntime
  readonly gate: FaultGate
  readonly collector: FoldCollector
}

/**
 * Whether this trial's own budget is what ended it.
 *
 * Three conditions, and each one is a measured case rather than a precaution: a trial with no budget was
 * never timed out; a caller cancellation is not a timeout (`timedOut` must not blame the budget for the
 * user's stop); and a result that says `completed` means the child finished inside the window between the
 * budget firing and the cancellation landing. That last one was the defect: `timedOut: true` beside
 * `stopReason: "completed"` is two facts that cannot both be true, in the one field a reader filters on to
 * exclude interrupted trials.
 * @param budget - the trial's own timer, if any.
 * @param signal - the caller's cancellation, which is what a stop reaches the subject through.
 * @param stopReason - what the runtime settled on.
 * @returns whether to record this trial as timed out.
 */
export function stoppedByBudget(
  budget: AbortSignal | undefined,
  signal: AbortSignal,
  stopReason: string,
): boolean {
  return budget !== undefined && budget.aborted && !signal.aborted && stopReason === 'aborted'
}

/**
 * Run one trial against the mounted harness and append its record.
 *
 * @param deps - the runtime seams.
 * @param plan - the stimulus and task for this trial.
 * @param parent - the calling agent, which supplies lineage and the default working directory.
 * @param signal - the caller's cancellation; a stop cancels the subject too.
 * @param run - the run whose record file receives the trial.
 * @param index - 1-based trial index.
 * @returns the summary the tool returns to the caller.
 */
export async function runTrial(
  deps: TrialDeps,
  plan: TrialPlan,
  parent: Agent,
  signal: AbortSignal,
  run: RunHandle,
  index: number,
): Promise<TrialOutcome> {
  // A trial-level budget, fused with the caller's signal so neither can be ignored. `AbortSignal.any`
  // keeps the first fire's reason, which is how `timedOut` is attributed below.
  const budget = plan.timeoutMs === null ? undefined : AbortSignal.timeout(plan.timeoutMs)
  const trialSignal = budget === undefined ? signal : AbortSignal.any([signal, budget])
  const startedAt = Date.now()

  const activation = await deps.subagents.startActivation({
    provider: 'spawn',
    label: `${plan.taskId} #${String(index)}`,
    delivery: 'caller',
    // Admission only — see the dispose listener below for the part that actually stops a child.
    signal: trialSignal,
    request: {
      prompt: [...plan.prompt],
      parent,
      agentPreset: plan.presetId,
      maxDepth: plan.maxDepth,
      ...(plan.cwd === null ? {} : { cwd: plan.cwd }),
      ...(plan.route === null
        ? {}
        : { agentOptions: { provider: plan.route.provider, model: plan.route.model } }),
      ...(plan.outputSchema === null ? {} : { outputSchema: plan.outputSchema }),
    },
  })

  const childId = String(activation.childId)
  const disarmGate = deps.gate.arm(childId, plan.faults)
  const disarmFold = deps.collector.arm(childId)
  // `startActivation`'s signal covers admission only: once the activation is accepted the child runs
  // on its own, so a budget that only aborts the signal leaves the subject working and the record
  // claiming a stop that never happened. Stopping is ours to do, and `dispose()` is what stops a
  // running child: it cancels the turn, waits for idle, then settles `result` as `aborted`.
  const detachStop = onceAborted(trialSignal, () => {
    void activation.dispose().catch(() => undefined)
  })
  try {
    const result = await activation.result
    const endedAt = Date.now()
    // Read, then release: the accumulator must not outlive the trial that owns it.
    const observations = deps.collector.read(childId)
    disarmFold()
    const timedOut = stoppedByBudget(budget, signal, result.stopReason)

    const record: TrialRecord = {
      runId: plan.runId,
      trial: index,
      stimulus: plan.stimulus,
      taskId: plan.taskId,
      childId,
      startedAt,
      endedAt,
      wallMs: endedAt - startedAt,
      stopReason: result.stopReason as TrialStopReason,
      timedOut,
      diagnostic: result.diagnostic ?? null,
      output: contentBlocksOf(result.output),
      structured: result.structured,
      trace: observations?.trace ?? null,
      modelInput: observations?.modelInput ?? null,
      observationsUnavailableReason:
        observations === undefined ? 'the collector was not armed for this session' : null,
    }
    await run.append(record)
    return {
      index,
      childId,
      stopReason: record.stopReason,
      wallMs: record.wallMs,
      toolCalls: record.trace?.toolCalls ?? 0,
      toolErrors: record.trace?.toolErrors ?? 0,
      observationsAvailable: observations !== undefined,
      timedOut,
    }
  } finally {
    // The caller's signal outlives this trial, so the listener must not.
    detachStop()
    disarmGate()
    disarmFold()
    // Dispose inside the trial's own finally: a throwing `result` must not leak the activation.
    await activation.dispose().catch(() => undefined)
  }
}
