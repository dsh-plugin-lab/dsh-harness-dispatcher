/**
 * Plugin entry: the Host half of the benchmark dispatcher.
 *
 * Mounts three things and nothing else:
 *   1. the `run_benchmark` tool,
 *   2. the fault gate's three tool-pipeline listeners (inert until a trial arms them),
 *   3. the trace collector's committed-event listener (inert for unarmed sessions),
 * plus a system-prompt section that appears only when the tool is visible in that agent's scope.
 *
 * @module dsh-harness-dispatcher
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_TOOLS, TOOL_KEYS } from './catalog.ts'
import { FaultGate } from './gate.ts'
import { TraceCollector } from './observe.ts'
import { registerRunBenchmark } from './tools/run-benchmark.ts'

export const name = 'harness-dispatcher'

/**
 * All five are hard dependencies on purpose. A bench that silently degraded when one was missing would
 * still produce records — records that were measured against nothing.
 *
 * `tools` registers the tool; `agentPresets` mounts the subject composition; `subagents` starts it;
 * `sessions` is the store the subject's Session is created in; `systemPrompt` carries the guidance.
 *
 * Note: the trace is folded from `session/event`, which needs no service — the collector borrows the
 * same context.
 */
export const inject = ['tools', 'agentPresets', 'subagents', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** Directory that receives one subdirectory per benchmark run. Empty means the default under home. */
  outputRoot: string
  /** Catalog keys a harness offers when it names none. */
  defaultTools: string[]
  /** Delegation budget granted to a subject when a harness names none. */
  defaultMaxDepth: number
  /** Upper bound on trials per call, so one tool call cannot monopolise the host. */
  maxTrials: number
}

export const Config: z<Config> = z.object({
  outputRoot: z.string().default(''),
  defaultTools: z.array(z.string()).default([...DEFAULT_TOOLS]),
  defaultMaxDepth: z.natural().min(1).default(1),
  maxTrials: z.natural().min(1).max(50).default(10),
})

/**
 * Install the bench.
 * @param ctx - the plugin's context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const outputRoot = config.outputRoot.trim() === ''
    ? join(homedir(), '.dsh', 'harness-dispatcher', 'runs')
    : config.outputRoot

  // Fail at load, not at run time: a default tool key that does not exist would otherwise surface as a
  // malformed subject composition after a child had already been started.
  //
  // `TOOL_KEYS.has()`, not the `in` operator: `in` tests property names on the Set object itself, so
  // `'fs' in TOOL_KEYS` is always false and every key would be rejected. Caught by installing the
  // plugin — the type checker and the unit tests cannot see the difference.
  for (const tool of config.defaultTools) {
    if (!TOOL_KEYS.has(tool)) {
      throw new Error(`harness-dispatcher: defaultTools names an unknown catalog key "${tool}"`)
    }
  }

  const gate = new FaultGate()
  gate.attach(ctx)
  const collector = new TraceCollector()
  collector.attach(ctx)

  registerRunBenchmark(ctx, {
    presets: ctx.agentPresets,
    subagents: ctx.subagents,
    gate,
    collector,
    config: {
      outputRoot,
      defaultTools: config.defaultTools,
      defaultMaxDepth: config.defaultMaxDepth,
      maxTrials: config.maxTrials,
    },
  })

  // Guidance, scoped: an agent that cannot see `run_benchmark` gets no text about it.
  ctx.systemPrompt.section({
    name: 'tool:run_benchmark',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => {
      if (ctx.tools.get('run_benchmark', context.scope) === undefined) return ''
      return 'To compare harnesses, hold the task fixed and call `run_benchmark` once per harness '
        + 'variant with the same `task_id` and `prompt`. Never change the task between variants — the '
        + 'only variable is the `harness` argument.'
    },
  })

  ctx.logger.info(`harness-dispatcher: records → ${outputRoot}`)
}
