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

import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { onceAborted } from './abort.ts'
import type { FoldCollector } from './collector.ts'
import type { Fault } from './fault.ts'
import type { FaultGate } from './gate.ts'
import type { HostRead } from './host.ts'
import type { RunHandle, StimulusRecord, TrialRecord, TrialStopReason } from './record.ts'
import { contentBlocksOf, errorMessage } from './text.ts'

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
  /**
   * The route as the record holds it, so the request and the evidence come from one value.
   *
   * Read straight off `StimulusRecord.route` rather than a second shape: a trial that sent something the
   * record did not name is how "the fingerprint is the stimulus" stops being true.
   */
  readonly route: StimulusRecord['route']
  readonly faults: readonly Fault[]
  /** Keep the subject's committed events verbatim in the run directory. Defaults to on. */
  readonly recordEvents: boolean
}

/** What one trial produced, for the tool's return value. */
export interface TrialOutcome {
  /** 1-based trial index, under the same name the record and the tool's output use. */
  readonly trial: number
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
  /**
   * Read the host's own projection values for the subject's Session.
   *
   * Supplied by the tool layer, which is the only place allowed to know a host service's shape. A trial
   * that cannot read them records why; it never invents zeros.
   */
  readonly readHost: (session: unknown) => HostRead
  /**
   * Report a cleanup that failed where nothing else would notice.
   *
   * The two `dispose()` calls below must not mask the error that got us here, so they cannot throw; but
   * a leaked activation keeps a whole Session alive, and swallowing that silently is how a leak becomes
   * invisible. Every other cleanup in this repository warns through the logger; this one had no channel
   * to do it through.
   */
  readonly warn: (message: string) => void
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
 * The host's `AgentOptions` for one route, or `undefined` when nothing was overridden.
 *
 * One translation, so the request the subject receives and the route the record names cannot drift. The
 * effort is cast rather than wrapped: `ReasoningEffortId()` is a compile-time brand with no validation
 * (the package says so), so wrapping would add a runtime dependency on `@deepseek-ai/dsh-llm` to produce
 * a string that is already correct.
 * @param route - the resolved route.
 * @returns the options, carrying only the fields that were actually given.
 */
function optionsOf(route: StimulusRecord['route']): AgentOptions | undefined {
  const options: AgentOptions = {
    ...(route.provider === null ? {} : { provider: route.provider }),
    ...(route.model === null ? {} : { model: route.model }),
    ...(route.reasoningEffort === null
      ? {}
      : { reasoningEffort: route.reasoningEffort as ReasoningEffortId }),
    ...(route.maxTokens === null ? {} : { maxTokens: route.maxTokens }),
  }
  return Object.keys(options).length === 0 ? undefined : options
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

  const options = optionsOf(plan.route)
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
      // The host selects a route before it applies a generation control: `applyConfiguredRoute` returns
      // early unless both provider and model are present, so `resolveRoute` refuses a control without a
      // route rather than letting it be silently dropped here.
      ...(options === undefined ? {} : { agentOptions: options }),
      ...(plan.outputSchema === null ? {} : { outputSchema: plan.outputSchema }),
    },
  })

  const childId = String(activation.childId)
  const disarmGate = deps.gate.arm(childId, plan.faults)
  const disarmFold = deps.collector.arm(childId, plan.recordEvents)
  // `startActivation`'s signal covers admission only: once the activation is accepted the child runs
  // on its own, so a budget that only aborts the signal leaves the subject working and the record
  // claiming a stop that never happened. Stopping is ours to do, and `dispose()` is what stops a
  // running child: it cancels the turn, waits for idle, then settles `result` as `aborted`.
  const detachStop = onceAborted(trialSignal, () => {
    void activation.dispose().catch((error: unknown) => {
      deps.warn(`harness_run: stopping the subject failed: ${errorMessage(error)}`)
    })
  })
  try {
    const result = await activation.result
    const endedAt = Date.now()
    // Read, then release: the accumulator must not outlive the trial that owns it.
    const observations = deps.collector.read(childId)
    const events = deps.collector.takeEvents(childId) ?? []
    // The Session object, not its id: `result` has already settled by now, so the session store no
    // longer answers for this child. Measured — an id-based read returned `host: null` on every trial.
    const host = deps.readHost(deps.collector.sessionOf(childId))
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
      host: host.ok ? { asOfSeq: host.asOfSeq, values: host.values } : null,
      hostUnavailableReason: host.ok ? null : host.reason,
      observationsUnavailableReason:
        observations === undefined ? 'the collector was not armed for this session' : null,
    }
    await run.append(record)
    await run.appendEvents(index, events)
    return {
      trial: index,
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
    await activation.dispose().catch((error: unknown) => {
      deps.warn(`harness_run: releasing the subject failed: ${errorMessage(error)}`)
    })
  }
}
