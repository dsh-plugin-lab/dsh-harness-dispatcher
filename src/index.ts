/**
 * Plugin entry: the Host half of the harness bench.
 *
 * Mounts three tools, one skill and two inert listeners — `harness_inspect` (mount and report, spend
 * nothing), `harness_export` (a preset's rows as an editable file), `harness_run` (one task, N trials),
 * the usage skill, the fault gate's three tool-pipeline listeners, and the fold collector's event
 * listener — plus a prompt section that appears only where those tools are visible in scope.
 *
 * @module dsh-harness-dispatcher
 */

import type { Context } from '@deepseek-ai/cordis'
import { CATALOG, TOOL_KEYS } from './catalog.ts'
import { FoldCollector } from './collector.ts'
import { Config, resolveConfig } from './config.ts'
import type { Config as PluginConfig } from './config.ts'
import { FaultGate } from './gate.ts'
import { registerSkill } from './skill.ts'
import { registerHarnessExport } from './tools/harness-export.ts'
import { registerHarnessInspect } from './tools/harness-inspect.ts'
import { registerHarnessRun } from './tools/harness-run.ts'

export const name = 'harness-dispatcher'

export { Config }
export type { PluginConfig }

/**
 * All four are hard dependencies on purpose. A bench that silently degraded when one was missing would
 * still produce records — measured against nothing.
 *
 * `skills` is deliberately **not** injected: the usage skill is helpful, not load-bearing, so it is
 * registered when a registry exists and skipped otherwise, and the surface reports `skills: null`.
 * Requiring it would refuse to load this plugin in a profile that ships no skills.
 */
export const inject = ['tools', 'agentPresets', 'subagents', 'systemPrompt']

/** Number of the current private mount, so two inspections cannot share a preset id. */
let mountCounter = 0

/**
 * Install the bench.
 * @param ctx - the plugin's context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const resolved = resolveConfig(config, ctx.baseUrl)

  // Fail at load, not at run time: a default tool key that does not exist would otherwise surface as a
  // malformed harness after a child had already been started.
  //
  // `TOOL_KEYS.has()`, not the `in` operator: `in` tests property names on the Set object itself, so
  // `'fs' in TOOL_KEYS` is always false and every key would be rejected. Caught by installing the
  // plugin — the type checker and the unit tests cannot see the difference.
  for (const key of resolved.defaultTools) {
    if (!TOOL_KEYS.has(key)) {
      throw new Error(`harness-dispatcher: defaultTools names an unknown catalogue key "${key}"`)
    }
  }

  const gate = new FaultGate()
  gate.attach(ctx)
  const collector = new FoldCollector()
  collector.attach(ctx)

  const defaults = {
    tools: resolved.defaultTools,
    maxDepth: resolved.defaultMaxDepth,
    harnessDir: resolved.harnessDir,
  }

  registerHarnessRun(ctx, {
    presets: ctx.agentPresets,
    subagents: ctx.subagents,
    gate,
    collector,
    defaults,
    vocabulary: CATALOG,
    limits: {
      outputRoot: resolved.outputRoot,
      maxTrials: resolved.maxTrials,
      trialTimeoutMs: resolved.trialTimeoutMs,
    },
  })

  registerHarnessInspect(ctx, {
    defaults,
    vocabulary: CATALOG,
    nextId: () => `inspect-${String((mountCounter += 1))}`,
  })

  registerHarnessExport(ctx, { harnessDir: resolved.harnessDir })

  registerSkill(ctx)

  // Guidance, scoped: an agent that cannot see the tools gets no text about them. It states the loop and
  // points at the skill, because the two traps a caller cannot infer from a tool list are documented
  // there.
  ctx.systemPrompt.section({
    name: 'tool:harness_run',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: (context) => {
      if (ctx.tools.get('harness_run', context.scope) === undefined) return ''
      return (
        'To compare harnesses, hold the task fixed and call `harness_run` once per harness with the ' +
        'same `task_id` and `prompt` — the only variable is the harness argument. Both `harness_inspect` ' +
        'and `harness_export` are free (no agent, no tokens): inspect before running, and export a ' +
        'shipped preset to start from a harness that already mounts. Load the `dsh-harness-dispatcher` ' +
        'skill for the loop and the two tool-name namespaces.'
      )
    },
  })

  ctx.logger.info(
    `harness-dispatcher: records → ${resolved.outputRoot}; harness files → ${resolved.harnessDir}`,
  )
}
