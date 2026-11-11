/**
 * One tool: run a task N times against one harness, record each trial, return handles.
 *
 * The shape is deliberately narrow — one harness, one task, N trials — because the comparison an
 * experiment makes is *across calls*, with the task held fixed and the harness as the only change. A
 * tool that also fanned out across harnesses would tempt callers into varying two things at once.
 *
 * ## The order of operations is the safety property
 *
 * ```
 * 1  capture the harness once (read or compile)              — no host state, no tokens
 * 2  open the run directory, write the capture into it        — evidence exists before anything runs
 * 3  mount THAT capture, audit it, probe it                   — zero model calls
 * 4  run the trials                                           — the only expensive part
 * 5  always unmount; on any failure before 4, remove the directory
 * ```
 *
 * Step 3 before step 4 is not tidiness. `agentPresets.register()` resolves even when the mount failed
 * and keeps the diagnostic in its own record, so without reading it back a broken harness used to
 * produce a run directory and an empty `trials.jsonl` — a *plausible empty result*, which is the worst
 * outcome an experiment can have. Step 5's removal makes the failure visible as failure.
 *
 * @module dsh-harness-dispatcher/tools/harness-run
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FoldCollector } from '../collector.ts'
import { assertFaultsReachable, normalizeFaults } from '../fault.ts'
import type { FaultGate } from '../gate.ts'
import type { ResolveDeps } from '../harness.ts'
import { harnessLabel, harnessRows, mountPathFor, resolveHarness } from '../harness.ts'
import { openRun, stimulusRecord } from '../record.ts'
import { mountSubject, presetIdFor } from '../subject.ts'
import type { Subject } from '../subject.ts'
import { runTrial } from '../trial.ts'
import type { TrialOutcome } from '../trial.ts'
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
    runId: { type: 'string', required: true },
    fingerprint: { type: 'string', required: true },
    directory: { type: 'string', required: true },
    recordPath: { type: 'string', required: true },
    harnessPath: { type: 'string', required: true },
    trials: { type: 'number', required: true },
    recorded: { type: 'number', required: true },
    completed: { type: 'number', required: true },
    // One entry per trial. `stopReason` is the outcome; the folded views live in the record file.
    outcomes: {
      type: 'array',
      required: true,
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
        'records are self-sufficient evidence. Returns a run handle and per-trial outcomes. Computing ' +
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
            'Per-trial wall-time budget. When it fires the trial is recorded with `timedOut: true` ' +
            'and `stopReason: "aborted"` — an observation, not an error.',
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
              `${String(value.completed)}/${String(value.trials)} trials recorded → ${value.recordPath}` +
              `\nharness ${value.fingerprint} captured at ${value.harnessPath}`,
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
        const timeoutMs = args.timeout_ms ?? deps.limits.trialTimeoutMs
        const outputSchema = (args.output_schema as ObjectJsonSchema | undefined) ?? null
        const cwd = args.cwd ?? null

        const runId = `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
        const stimulus = stimulusRecord(harness, faults)
        const presetId = presetIdFor(runId)

        // Capture first, then mount the capture: what is mounted is byte-identical to what the run
        // directory holds, because both come from the one string in `harness.captured.text`.
        const run = await openRun(
          deps.limits.outputRoot,
          {
            runId,
            startedAt: Date.now(),
            stimulus,
            task: {
              taskId: args.task_id,
              prompt: args.prompt,
              cwd,
              outputSchemaRequested: outputSchema !== null,
              outputSchema,
            },
            note: null,
          },
          harness.captured,
        )

        let subject: Subject | undefined
        let started = false
        const outcomes: TrialOutcome[] = []
        try {
          subject = await mountSubject(ctx, {
            presetId,
            label: harnessLabel(harness.captured),
            rows: harnessRows(harness.captured, mountPathFor(harness.captured, run.harnessPath)),
          })
          // Only a harness that can actually receive them may claim them in its record.
          assertFaultsReachable(faults, subject.surface.tools)
          // Observed, so it is written after the observation — never as a placeholder.
          await run.annotate(subject.surface)

          const plan = {
            runId,
            presetId,
            stimulus,
            taskId: args.task_id,
            prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
            cwd,
            outputSchema,
            timeoutMs: timeoutMs > 0 ? timeoutMs : null,
            maxDepth: harness.maxDepth,
            route: stimulus.route,
            faults,
          }

          started = true
          for (let index = 1; index <= trials; index += 1) {
            exec.signal.throwIfAborted()
            outcomes.push(await runTrial(deps, plan, parent, exec.signal, run, index))
          }

          return {
            runId,
            fingerprint: harness.fingerprint,
            directory: run.directory,
            recordPath: run.recordPath,
            harnessPath: run.harnessPath,
            trials,
            recorded: outcomes.length,
            completed: outcomes.filter((outcome) => outcome.stopReason === 'completed').length,
            outcomes: outcomes.map((outcome) => ({
              trial: outcome.index,
              childId: outcome.childId,
              stopReason: outcome.stopReason,
              wallMs: outcome.wallMs,
              toolCalls: outcome.toolCalls,
              toolErrors: outcome.toolErrors,
              observationsAvailable: outcome.observationsAvailable,
              timedOut: outcome.timedOut,
            })),
          }
        } catch (error) {
          // A cancelled or failed run has usually still recorded something. Saying so is the difference
          // between "I lost my work" and "the first 3 of 10 are on disk".
          if (started && outcomes.length > 0) {
            throw new Error(
              `${describe(error)}\n${String(outcomes.length)}/${String(trials)} trial(s) were already ` +
                `recorded and are readable at ${run.recordPath} — the directory is kept, it is data.`,
              { cause: error },
            )
          }
          throw error
        } finally {
          if (subject !== undefined) {
            // Always unmount: a leaked preset keeps a whole Loader tree alive and makes a later mount of
            // the same id fail with a duplicate-entry error.
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
      },
    }),
  )
}

/** The message of an unknown thrown value, without losing a non-Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
