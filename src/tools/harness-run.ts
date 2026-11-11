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
import type { AttachmentPlan, AttachmentStoreSeam, PromptSeam } from '../attachments.ts'
import { imageDeliveryProblem, planAttachment, resolvePrompt } from '../attachments.ts'
import type { FoldCollector } from '../collector.ts'
import { normalizeFaults } from '../fault.ts'
import type { FaultGate } from '../gate.ts'
import type { ResolveDeps, ResolvedHarness } from '../harness.ts'
import { resolveHarness } from '../harness.ts'
import { readHost } from '../host.ts'
import { jobOutcomeOf } from '../jobs.ts'
import type { JobRegistry } from '../jobs.ts'
import { runDirectoryFor } from '../record.ts'
import { runBench, summaryLine } from '../run.ts'
import type { RunDeps, RunRequest, TrialSummary } from '../run.ts'
import {
  ATTACHMENTS_PARAMETER,
  FAULTS_PARAMETER,
  RECORD_EVENTS_PARAMETER,
  REQUIRED_HARNESS,
  ROUTE_PARAMETERS,
  faultsOf,
  harnessInputOf,
} from './params.ts'
import type { ModelRouter } from './params.ts'

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
    // Present only when the caller stopped before every trial ran. `recorded < trials` alone would not
    // say whether the rest were skipped or the run broke.
    stopped: { type: 'boolean' },
    jobId: { type: 'string' },
    // One entry per trial, foreground only. `stopReason` is the outcome; everything else is in the file.
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
        ...ATTACHMENTS_PARAMETER,
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
        ...RECORD_EVENTS_PARAMETER,
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
                  `\nharness ${value.fingerprint} captured at ${value.harnessPath ?? value.directory}` +
                  (value.stopped === true
                    ? `\nstopped before every trial ran; the ${String(value.recorded ?? 0)} recorded ` +
                      'are complete records, and no further trial was started'
                    : '')
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
        // Kinds are decided from the extension alone, so the route gate below costs no I/O and comes
        // first: an image that this route cannot deliver must be refused before its bytes are stored.
        const attached = args.attachments ?? []
        await assertImagesDeliverable(
          ctx,
          harness,
          parent,
          attached.map((item) => planAttachment(item.path)),
        )
        // The task is built last, because building it writes to the attachment store — cheap and
        // content-addressed, but still the one step that touches host state, so it goes after every
        // argument that could have been wrong.
        const prompt = await resolvePrompt(
          args.prompt,
          attached,
          promptSeam(ctx, exec.signal, args.cwd ?? null),
        )

        const request: RunRequest = {
          // Created here, not inside the run: a background run has to name itself before it starts.
          runId: `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
          harness,
          faults,
          sealed: args.harness?.sealed === true,
          taskId: args.task_id,
          prompt,
          cwd: args.cwd ?? null,
          outputSchema: (args.output_schema as ObjectJsonSchema | undefined) ?? null,
          timeoutMs: args.timeout_ms ?? deps.limits.trialTimeoutMs,
          trials,
          recordEvents: args.record_events ?? true,
        }
        const depsForRun = {
          presets: deps.presets,
          subagents: deps.subagents,
          gate: deps.gate,
          collector: deps.collector,
          // Bound here because the tool layer is the only place that may know a host service's shape.
          readHost: (session: unknown) => readHost(ctx, session),
          outputRoot: deps.limits.outputRoot,
        }

        if (args.run_in_background === true) {
          return startBackground(ctx, deps, depsForRun, request, parent, {
            callId: exec.callId,
            rootCallId: exec.rootCallId ?? exec.callId,
          })
        }

        // The caller's stop cancels the trial in flight as well: a stop means the experiment is
        // abandoned, and a button whose effect waits for one more trial reads as broken. The pipeline
        // replaces this call's return value with `Error: tool call aborted`, so the records on disk are
        // what the caller has left to read.
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
          ...(summary.stopped ? { stopped: true } : {}),
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
          const summary = await runBench(
            ctx,
            runDeps,
            request,
            parent,
            // The job's own controller: the tool call has returned, so its signal is spent.
            controller.signal,
            {
              onTrial: (outcome, recorded) => {
                job.updateProgress(`trial ${String(recorded)}/${String(request.trials)}`)
                // Unlabelled on purpose: the registry's `log` channel is producer narration for
                // observers and **never reaches the model** (`dsh-tool-jobs`' own render rule).
                // Per-trial lines exist to be read by whoever is waiting, so they must not carry that
                // label.
                job.append(`${trialLine(outcome, request.trials)}\n`)
              },
            },
          )
          // `stopped` comes from the run itself: a kill leaves a partial summary, not a rejection.
          return jobOutcomeOf(stopped || summary.stopped, undefined, summaryLine(summary))
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

/**
 * The host services an attachment needs, bound to this call.
 *
 * Both are optional services, so both are looked up rather than injected: a profile with no attachment
 * store still runs text-only tasks. `read` goes through the host filesystem backend for the same reason
 * `read_image` does — it is the one thing that knows the execution world's paths and the sandbox.
 * @param ctx - context that may expose `attachments` and `fs`.
 * @param signal - cancellation for the reads.
 * @param cwd - the task's working directory, so a relative attachment resolves where the subject runs.
 * @returns the seam an attachment resolution needs.
 */
function promptSeam(ctx: Context, signal: AbortSignal, cwd: string | null): PromptSeam {
  const store: AttachmentStoreSeam | undefined = ctx.get('attachments')
  return {
    attachments: store,
    async read(path: string, maxBytes: number): Promise<Uint8Array> {
      const fs = ctx.get('fs')
      if (fs === undefined) {
        throw new Error(
          `cannot attach "${path}": this profile mounts no filesystem service, so the path cannot be ` +
            'resolved. Load @deepseek-ai/dsh-fs (and a backend), or drop `attachments`.',
        )
      }
      const target = await fs.resolve(path, {
        signal,
        ...(cwd === null ? {} : { cwd }),
      })
      const info = await fs.stat(target, signal)
      if (info === undefined) throw new Error(`cannot attach "${path}": no such file`)
      if (info.type !== 'file') throw new Error(`cannot attach "${path}": not a regular file`)
      return fs.readBytes(target, signal, maxBytes)
    },
  }
}

/**
 * Refuse an image the subject's route cannot deliver, before anything is stored or run.
 *
 * The host does not fail here: `LlmRuntime` replaces every image with a placeholder line when the
 * resolved model does not declare `image` input, so the trials would run without the input they were
 * given and the record would look normal. The route checked is the **subject's**, resolved the way the
 * host's own `read_image` resolves the calling route — the bench's route override first, then the
 * parent's recorded request, then the parent's options — because a bench that validated the caller's
 * route would be asking a different question.
 * @param ctx - context that may expose the llm runtime.
 * @param harness - the resolved harness, whose route override is the first choice.
 * @param parent - the calling agent, which supplies the inherited route.
 * @param plans - the attachments about to be sent.
 * @throws {Error} when an image is attached and the route cannot take it.
 */
async function assertImagesDeliverable(
  ctx: Context,
  harness: ResolvedHarness,
  parent: Agent,
  plans: readonly AttachmentPlan[],
): Promise<void> {
  if (!plans.some((plan) => plan.kind === 'image')) return
  const recorded = parent.session.requestHeader()?.config
  const provider = harness.route.provider ?? recorded?.provider ?? parent.options.provider
  const model = harness.route.model ?? recorded?.model ?? parent.options.model
  if (provider === undefined || model === undefined) {
    throw new Error(imageDeliveryProblem(null, undefined) ?? 'unresolvable image route')
  }
  const llm: ModelRouter | undefined = ctx.get('llm')
  if (llm === undefined) {
    throw new Error(
      imageDeliveryProblem(`${provider}/${model}`, undefined) ?? 'unresolvable image route',
    )
  }
  let info: { readonly inputModalities?: readonly string[] }
  try {
    info = (await llm.resolveModelInfo(provider, model)) as typeof info
  } catch (error) {
    // The adapter's own complaint ("no adapter registered for provider X") is true but says nothing
    // about why this call cares. Naming the attachment is the difference between "my route is wrong"
    // and "the image is why my route suddenly has to be right".
    throw new Error(
      `cannot attach an image: route ${provider}/${model} could not be resolved — ` +
        `${describe(error)}. Pass an image-capable \`provider\`/\`model\`, or drop the image.`,
      { cause: error },
    )
  }
  // Absent modalities mean "unknown", and unknown is not a promise: the host's own gate treats it as a
  // refusal, and so does this one.
  const problem = imageDeliveryProblem(
    `${provider}/${model}`,
    info.inputModalities?.includes('image'),
  )
  if (problem !== undefined) throw new Error(problem)
}

/** The message of an unknown thrown value, without losing a non-Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
