/**
 * One tool: run a task N times against one harness, record each trial, return handles.
 *
 * One harness, one task, N trials — the comparison is *across calls*, so a tool that also fanned out
 * across harnesses would tempt callers into changing two things at once.
 *
 * **Two waits, one experiment.** By default the call waits for every trial, which is right for the short
 * runs most ablations are. `run_in_background: true` registers the same run as an owned `ctx.jobs` job
 * and returns at once, so a long run does not hold the caller's turn. That is the host's own pattern for
 * long work (`pwsh` and `workflow` both do it this way); the completion notice is the runtime's, not
 * something this plugin sends. The run itself is [run.ts](../run.ts) in both cases — two execution paths
 * would eventually mean two experiments behind one name.
 *
 * @module dsh-harness-dispatcher/tools/harness-run
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FoldCollector } from '../collector.ts'
import { normalizeFaults } from '../fault.ts'
import type { FaultGate } from '../gate.ts'
import type { ResolveDeps } from '../harness.ts'
import { resolveHarness } from '../harness.ts'
import { jobOutcomeOf } from '../jobs.ts'
import type { JobRegistry } from '../jobs.ts'
import { runDirectoryFor } from '../record.ts'
import { runBench, summaryLine } from '../run.ts'
import type { RunDeps, RunRequest, TrialSummary } from '../run.ts'
import {
  FAULTS_PARAMETER,
  REQUIRED_HARNESS,
  ROUTE_PARAMETERS,
  faultsOf,
  harnessInputOf,
} from './params.ts'

/** Everything the tool needs from the plugin instance. */
export interface HarnessRunDeps extends ResolveDeps {
  /** Registry used to mount and unmount the harness. */
  readonly presets: AgentPresetRegistry
  /** Runtime used to start the subject. */
  readonly subagents: SubagentRuntime
  /** Per-subject fault arming. */
  readonly gate: FaultGate
  /** Per-subject folding. */
  readonly collector: FoldCollector
  /** Run-level configuration. */
  readonly limits: {
    readonly outputRoot: string
    readonly maxTrials: number
    readonly trialTimeoutMs: number
  }
}

/** Output schema: a handle, never prose. Callers and PTC programs read fields, not sentences. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Which wait this call took. A caller that has to guess whether the trials are done reads every
    // other field wrongly.
    kind: { type: 'string', required: true },
    runId: { type: 'string', required: true },
    fingerprint: { type: 'string', required: true },
    directory: { type: 'string', required: true },
    trials: { type: 'number', required: true },
    // Present only when this call waited. A background call has recorded nothing yet, and `0` would
    // read as a measurement rather than as "not yet".
    recordPath: { type: 'string' },
    harnessPath: { type: 'string' },
    recorded: { type: 'number' },
    completed: { type: 'number' },
    jobId: { type: 'string' },
    // One entry per trial, foreground only. `stopReason` is the outcome; the folded views are in the file.
    outcomes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          trial: { type: 'number', required: true },
          childId: { type: 'string', required: true },
          stopReason: { type: 'string', required: true },
          wallMs: { type: 'number', required: true },
          toolCalls: { type: 'number', required: true },
          toolErrors: { type: 'number', required: true },
          observationsAvailable: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

/** How a background run registers itself. The host's kind vocabulary, extended by one. */
const JOB_KIND = 'harness'

/**
 * Register `harness_run`.
 * @param ctx - context owning the registration.
 * @param deps - plugin services, defaults and limits.
 */
export function registerHarnessRun(ctx: Context, deps: HarnessRunDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'harness_run',
      description:
        'Run one task repeatedly against ONE harness and record every trial to a JSONL file. Hold the ' +
        'task and prompt fixed; change only the harness argument between calls — that is what makes ' +
        'two runs comparable. The run directory receives a verbatim copy of the harness, so the ' +
        'records are self-sufficient evidence. Returns a run handle and per-trial outcomes; ' +
        '`run_in_background: true` returns a job id instead, for runs too long to wait on. Computing ' +
        "statistics is deliberately not this tool's job: the records are the deliverable.",
      parameters: {
        task_id: {
          type: 'string',
          required: true,
          description:
            'Stable identity of the task. Part of the controlled input: keep it identical ' +
            'across harness variants.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The task text handed to the subject. Identical across harness variants.',
        },
        trials: {
          type: 'number',
          description:
            'How many independent trials to run. Each trial is a fresh subagent session.',
        },
        cwd: {
          type: 'string',
          description:
            'Initial working directory for the subject. Part of the TASK, not the harness: the same ' +
            'prompt against a different directory is a different question.',
        },
        output_schema: {
          type: 'json',
          description:
            "JSON Schema the subject must satisfy. When set, the record carries the subject's " +
            'structured answer beside its prose, so grading can happen outside this process against a ' +
            'deterministic signal instead of a semantic score.',
        },
        timeout_ms: {
          type: 'number',
          description:
            'Per-trial wall-time budget. When it fires the subject is stopped and the trial is ' +
            'recorded with `timedOut: true` and `stopReason: "aborted"` — an observation, not an error.',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Register this run as a background job and return at once instead of waiting. Use it when ' +
            'the trials would keep this turn busy for minutes. The job streams per-trial progress to ' +
            '`job_output`, ends with a completion notice, and `job_kill` stops it — the records already ' +
            'written stay. Requires the host to mount `tool-jobs`.',
        },
        ...REQUIRED_HARNESS,
        ...ROUTE_PARAMETERS,
        ...FAULTS_PARAMETER,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.jobId === undefined
                ? `${String(value.recorded ?? 0)}/${String(value.trials)} trial(s) recorded, ` +
                  `${String(value.completed ?? 0)} completed → ${value.recordPath ?? value.directory}` +
                  `\nharness ${value.fingerprint} captured at ${value.harnessPath ?? value.directory}`
                : `started background run ${value.jobId} → ${value.directory}` +
                  `\nharness ${value.fingerprint} · ${String(value.trials)} trial(s) queued. ` +
                  '`job_output` reads per-trial progress, a completion notice brings the totals, ' +
                  '`job_kill` stops it and keeps what was already recorded.',
          },
        ],
      },
      // Two overlapping calls would mount two harnesses at once. The gate and collector are keyed by
      // session so this would still be correct, but the record files and the mount/unmount ordering are
      // easier to reason about when one call owns the bench at a time.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('harness_run requires a calling agent')

        // Everything that can be rejected is rejected before any host state exists.
        const harness = await resolveHarness(harnessInputOf(args), deps)
        const faults = normalizeFaults(faultsOf(args))
        const trials = args.trials ?? 1
        if (!Number.isSafeInteger(trials) || trials < 1 || trials > deps.limits.maxTrials) {
          throw new Error(`trials must be an integer from 1 to ${String(deps.limits.maxTrials)}`)
        }

        const request: RunRequest = {
          // Created here, not inside the run: a background run has to name itself before it starts.
          runId: `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
          harness,
          faults,
          sealed: args.harness?.sealed === true,
          taskId: args.task_id,
          prompt: args.prompt,
          cwd: args.cwd ?? null,
          outputSchema: (args.output_schema as ObjectJsonSchema | undefined) ?? null,
          timeoutMs: args.timeout_ms ?? deps.limits.trialTimeoutMs,
          trials,
        }
        const depsForRun = {
          presets: deps.presets,
          subagents: deps.subagents,
          gate: deps.gate,
          collector: deps.collector,
          outputRoot: deps.limits.outputRoot,
        }

        if (args.run_in_background === true) {
          return startBackground(ctx, deps, depsForRun, request, parent, {
            callId: exec.callId,
            rootCallId: exec.rootCallId ?? exec.callId,
          })
        }

        const summary = await runBench(ctx, depsForRun, request, parent, exec.signal)
        const completed = summary.outcomes.filter(
          (outcome) => outcome.stopReason === 'completed',
        ).length
        return {
          kind: 'foreground',
          runId: summary.runId,
          fingerprint: summary.fingerprint,
          directory: summary.directory,
          recordPath: summary.recordPath,
          harnessPath: summary.harnessPath,
          trials: summary.trials,
          recorded: summary.outcomes.length,
          completed,
          outcomes: summary.outcomes.map(outcomeOf),
        }
      },
    }),
  )
}

/** The tool's flat per-trial shape. */
function outcomeOf(outcome: TrialSummary): {
  trial: number
  childId: string
  stopReason: string
  wallMs: number
  toolCalls: number
  toolErrors: number
  observationsAvailable: boolean
  timedOut: boolean
} {
  return {
    trial: outcome.index,
    childId: outcome.childId,
    stopReason: outcome.stopReason,
    wallMs: outcome.wallMs,
    toolCalls: outcome.toolCalls,
    toolErrors: outcome.toolErrors,
    observationsAvailable: outcome.observationsAvailable,
    timedOut: outcome.timedOut,
  }
}

/**
 * Register the run as an owned job and return its id.
 *
 * The work starts inside the job's starter with **its own** signal, never the tool call's: the call has
 * already returned, so its signal is spent, and the run belongs to the job from then on. `job_kill` and
 * the owner's disposal both reach it through `cancel`, which is the one thing that stops a subject.
 * @param ctx - context that owns the job registry.
 * @param deps - plugin services.
 * @param runDeps - the run's own dependencies.
 * @param request - the validated stimulus and task.
 * @param parent - the calling agent, which owns the job.
 * @param toolCall - the creating invocation, kept in the durable lifecycle record.
 * @returns the handle's fields, with the job id rather than a completion count.
 */
function startBackground(
  ctx: Context,
  deps: HarnessRunDeps,
  runDeps: RunDeps,
  request: RunRequest,
  parent: Agent,
  toolCall: { readonly callId: string; readonly rootCallId: string },
): {
  kind: string
  runId: string
  fingerprint: string
  directory: string
  trials: number
  jobId: string
} {
  const jobs: JobRegistry | undefined = ctx.get('jobs')
  if (jobs === undefined) {
    throw new Error(
      'run_in_background needs the host to mount @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs: ' +
        'without them no controller serves this agent, so the run could be neither read nor stopped. ' +
        'Drop `run_in_background`, or mount them.',
    )
  }

  let stopped = false
  const jobId = jobs.start({
    kind: JOB_KIND,
    label: `${request.taskId} × ${String(request.trials)}`,
    owner: parent.id,
    toolCall,
    run: (job) => {
      // The job's own cancellation, not the spent tool-call signal.
      const controller = new AbortController()
      const done = (async () => {
        try {
          const summary = await runBench(ctx, runDeps, request, parent, controller.signal, {
            onTrial: (outcome, recorded) => {
              job.updateProgress(`trial ${String(recorded)}/${String(request.trials)}`)
              // Unlabelled on purpose: the registry's `log` channel is producer narration for
              // observers and **never reaches the model** (`dsh-tool-jobs`' own render rule). Per-trial
              // lines exist to be read by whoever is waiting, so they must not carry that label.
              job.append(`${trialLine(outcome, request.trials)}\n`)
            },
          })
          return jobOutcomeOf(false, undefined, summaryLine(summary))
        } catch (error) {
          // The run's error already says how many trials landed and where they are, so the result can
          // be the message itself rather than a second, slightly different summary.
          return jobOutcomeOf(stopped, error, describe(error))
        }
      })()
      return {
        cancel: (reason?: string) => {
          stopped = true
          controller.abort(reason ?? 'background harness run killed')
        },
        done,
      }
    },
  })

  return {
    kind: 'background',
    runId: request.runId,
    fingerprint: request.harness.fingerprint,
    directory: runDirectoryFor(deps.limits.outputRoot, request.runId),
    trials: request.trials,
    jobId,
  }
}

/** One line of per-trial progress, as `job_output` shows it. */
function trialLine(outcome: TrialSummary, total: number): string {
  const flags = [
    outcome.stopReason,
    `${String(outcome.toolCalls)} call(s)`,
    `${String(outcome.toolErrors)} error(s)`,
    `${String(outcome.wallMs)}ms`,
    ...(outcome.timedOut ? ['timed out'] : []),
  ]
  return `trial ${String(outcome.index)}/${String(total)}: ${flags.join(', ')}`
}

/** The message of an unknown thrown value, without losing a non-Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
