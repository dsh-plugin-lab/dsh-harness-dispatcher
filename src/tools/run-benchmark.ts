/**
 * One tool: run a task N times against one Harness variant, record each trial, return handles.
 *
 * The shape is deliberately narrow — one harness, one task, N trials — because the comparison an
 * experiment makes is *across calls*, with the task held fixed and the Harness as the only change.
 * A tool that also fanned out across harnesses would tempt callers into varying two things at once.
 *
 * @module dsh-harness-dispatcher/tools/run-benchmark
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { catalogLine, HARNESS_CATALOG } from '../catalog.ts'
import { normalize } from '../harness.ts'
import type { FaultMode, HarnessInput } from '../harness.ts'
import type { FaultGate } from '../gate.ts'
import type { TraceCollector } from '../observe.ts'
import { openRun } from '../record.ts'
import type { TrialRecord, TrialStopReason } from '../record.ts'
import { harnessPresetId, harnessRows } from '../preset-rows.ts'
import { contentBlocksOf } from '../text.ts'

/** Everything the tool needs from the plugin instance. */
export interface RunBenchmarkDeps {
  /** Registry used to mount and unmount the subject composition. */
  readonly presets: AgentPresetRegistry
  /** Runtime used to start the subject. */
  readonly subagents: SubagentRuntime
  /** Per-subject fault arming. */
  readonly gate: FaultGate
  /** Per-subject trace folding. */
  readonly collector: TraceCollector
  /** Deployment defaults and the run output root. */
  readonly config: {
    readonly outputRoot: string
    readonly defaultTools: readonly string[]
    readonly defaultMaxDepth: number
    readonly maxTrials: number
  }
}

/** Output schema: a handle, never prose. Callers and PTC programs read fields, not sentences. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    harnessId: { type: 'string', required: true },
    recordPath: { type: 'string', required: true },
    trials: { type: 'number', required: true },
    completed: { type: 'number', required: true },
    // One entry per trial. `stopReason` is the outcome; the folded trace lives in the record file.
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
          traceAvailable: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

/** Translate the tool's snake_case arguments into the spec input. */
function toHarnessInput(harness: {
  id?: string | undefined
  tools?: readonly string[] | undefined
  persona?: string | undefined
  persona_text?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  max_depth?: number | undefined
  faults?:
    | readonly {
        tool: string
        mode: string
        message?: string | undefined
        latency_ms?: number | undefined
      }[]
    | undefined
}): HarnessInput {
  const faults = harness.faults?.map((fault) => ({
    tool: fault.tool,
    // The enum is enforced by the parameter schema and again by `normalize`.
    mode: fault.mode as FaultMode,
    ...(fault.message === undefined ? {} : { message: fault.message }),
    ...(fault.latency_ms === undefined ? {} : { latencyMs: fault.latency_ms }),
  }))
  return {
    ...(harness.id === undefined ? {} : { id: harness.id }),
    ...(harness.tools === undefined ? {} : { tools: harness.tools }),
    ...(harness.persona === undefined
      ? {}
      : { persona: harness.persona as HarnessInput['persona'] }),
    ...(harness.persona_text === undefined ? {} : { personaText: harness.persona_text }),
    ...(harness.provider === undefined ? {} : { provider: harness.provider }),
    ...(harness.model === undefined ? {} : { model: harness.model }),
    ...(harness.max_depth === undefined ? {} : { maxDepth: harness.max_depth }),
    ...(faults === undefined ? {} : { faults }),
  }
}

/**
 * Register `run_benchmark`.
 * @param ctx - context owning the registration.
 * @param deps - plugin services and configuration.
 */
export function registerRunBenchmark(ctx: Context, deps: RunBenchmarkDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'run_benchmark',
      description:
        'Run one task repeatedly against ONE Harness variant and record every trial to a JSONL file. ' +
        'Hold the task and prompt fixed; change only the harness argument between calls — that is what ' +
        'makes two runs comparable. Returns a run handle and per-trial outcomes. Computing statistics ' +
        "is deliberately not this tool's job: the records are the deliverable. " +
        `Available harness tools: ${catalogLine()}.`,
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
        harness: {
          type: 'object',
          additionalProperties: false,
          required: true,
          description: 'The Harness under test. Omitted fields use deployment defaults.',
          properties: {
            id: {
              type: 'string',
              description: 'Short stable identity. Omit to derive one from the fields.',
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: `Catalog keys the subject is offered. Defaults to ${deps.config.defaultTools.join(', ')}.`,
            },
            persona: {
              type: 'string',
              enum: ['none', 'terse', 'verbose', 'pair-programmer', 'custom'],
              description:
                'Persona variant. "none" mounts no persona row, leaving the deployment persona.',
            },
            persona_text: { type: 'string', description: 'Prose used only with persona "custom".' },
            provider: {
              type: 'string',
              description: 'Model route override; supply together with model.',
            },
            model: {
              type: 'string',
              description: 'Model route override; supply together with provider.',
            },
            max_depth: { type: 'number', description: 'Delegation budget granted to the subject.' },
            faults: {
              type: 'array',
              description:
                'Injected tool faults. "deny" hides the tool (tests absence), "fail" makes it return an ' +
                'error the subject must handle (tests failure handling), "latency" delays the result ' +
                '(tests patience). These are three different experiments, not three settings of one.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  tool: { type: 'string', required: true },
                  mode: { type: 'string', required: true, enum: ['deny', 'fail', 'latency'] },
                  message: { type: 'string', description: 'Literal text the subject sees.' },
                  latency_ms: {
                    type: 'number',
                    description: 'Withheld interval, mode "latency" only.',
                  },
                },
              },
            },
          },
        },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [
          {
            type: 'text',
            text: `${String(value.completed)}/${String(value.trials)} trials recorded → ${value.recordPath}`,
          },
        ],
      },
      // Two overlapping calls would arm two subject compositions at once. The gate and collector are
      // keyed by session so this would still be correct, but the record files and the mount/unmount
      // ordering are easier to reason about when one call owns the bench at a time.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (parent === undefined) throw new Error('run_benchmark requires a calling agent')

        // Normalize before starting anything: an invalid spec must fail without leaving a child behind.
        const spec = normalize(
          toHarnessInput(args.harness),
          { tools: deps.config.defaultTools, maxDepth: deps.config.defaultMaxDepth },
          HARNESS_CATALOG,
        )

        const trials = args.trials ?? 1
        if (!Number.isSafeInteger(trials) || trials < 1 || trials > deps.config.maxTrials) {
          throw new Error(`trials must be an integer from 1 to ${String(deps.config.maxTrials)}`)
        }

        const runId = `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
        const run = await openRun(deps.config.outputRoot, {
          runId,
          startedAt: Date.now(),
          taskId: args.task_id,
          note: null,
        })

        // Mount the subject composition once for the whole run: every trial of one run must see the same
        // composition, and re-mounting per trial would let a Loader difference leak into the comparison.
        const presetId = harnessPresetId(runId)
        let unmount: () => Promise<void> = async () => {}

        try {
          unmount = await deps.presets.register({
            id: presetId,
            name: `bench ${spec.id}`,
            plugins: harnessRows(spec),
          })

          const outcomes: {
            trial: number
            childId: string
            stopReason: string
            wallMs: number
            toolCalls: number
            toolErrors: number
            traceAvailable: boolean
          }[] = []

          for (let trial = 1; trial <= trials; trial += 1) {
            exec.signal.throwIfAborted()
            const startedAt = Date.now()

            const activation = await deps.subagents.startActivation({
              provider: 'spawn',
              label: `${args.task_id} #${String(trial)} [${spec.id}]`,
              delivery: 'caller',
              signal: exec.signal,
              request: {
                prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
                parent,
                agentPreset: presetId,
                maxDepth: spec.maxDepth,
                ...(spec.route.provider === null || spec.route.model === null
                  ? {}
                  : {
                      agentOptions: { provider: spec.route.provider, model: spec.route.model },
                    }),
              },
            })

            const childId = String(activation.childId)
            // Arm both seams *before* awaiting the result, so the first event is never missed.
            const disarmGate = deps.gate.arm(childId, spec.faults)
            const disarmTrace = deps.collector.arm(childId)
            try {
              const result = await activation.result
              const endedAt = Date.now()

              // Read, then release: the accumulator must not outlive the trial that owns it.
              const trace = deps.collector.read(childId) ?? null
              disarmTrace()

              const record: TrialRecord = {
                runId,
                trial,
                harness: spec,
                taskId: args.task_id,
                childId,
                startedAt,
                endedAt,
                wallMs: endedAt - startedAt,
                stopReason: result.stopReason as TrialStopReason,
                diagnostic: result.diagnostic ?? null,
                output: contentBlocksOf(result.output),
                trace,
                traceUnavailableReason:
                  trace === null ? 'the collector was not armed for this session' : null,
              }
              await run.append(record)
              outcomes.push({
                trial,
                childId,
                stopReason: record.stopReason,
                wallMs: record.wallMs,
                toolCalls: trace?.toolCalls ?? 0,
                toolErrors: trace?.toolErrors ?? 0,
                traceAvailable: trace !== null,
              })
            } finally {
              disarmGate()
              disarmTrace()
              // Dispose inside the trial's own finally: a throwing `result` must not leak the activation.
              await activation.dispose().catch(() => undefined)
            }
          }

          return {
            runId,
            harnessId: spec.id,
            recordPath: run.recordPath,
            trials,
            completed: outcomes.filter((outcome) => outcome.stopReason === 'completed').length,
            outcomes,
          }
        } finally {
          // Always unmount: a leaked preset keeps a whole Loader tree alive and makes the next mount of
          // the same id fail with a duplicate-entry error.
          await unmount().catch((error: unknown) => {
            ctx.logger.warn(
              `run_benchmark: failed to unmount subject preset "${presetId}": ${String(error)}`,
            )
          })
        }
      },
    }),
  )
}
