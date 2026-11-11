/**
 * Plugin entry: the Host half of the harness bench.
 *
 * Mounts three tools, one skill, and two inert listeners, and nothing else:
 *
 *   1. `harness_inspect` — mount a harness, report what it would give the subject, spend nothing;
 *   2. `harness_export` — write a shipped preset's rows out as an editable harness file;
 *   3. `harness_run` — run one task N times against one harness, record every trial;
 *   4. the usage skill, so an agent finds the loop and its traps without reading source;
 *   5. the fault gate's three tool-pipeline listeners (inert until a trial arms them);
 *   6. the fold collector's committed-event listener (inert for unarmed sessions);
 *
 * plus a system-prompt section that appears only when those tools are visible in that agent's scope.
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
 * still produce records — records that were measured against nothing.
 *
 * `tools` registers the tools; `agentPresets` mounts and audits the harness; `subagents` starts the
 * subject; `systemPrompt` carries the guidance.
 *
 * `skills` is deliberately **not** injected: the usage skill is registered when the host has a skill
 * registry and skipped with a log line when it does not, and the capability surface reports
 * `skills: null` in that case. Making it required would refuse to load this plugin in a profile that
 * ships no skills, for something that is helpful rather than load-bearing.
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
  const resolved = resolveConfig(config)

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
        'shipped preset to start from a harness that already mounts. Load the `dsh-harness-bench` ' +
        'skill for the loop and the two tool-name namespaces.'
      )
    },
  })

  ctx.logger.info(
    `harness-dispatcher: records → ${resolved.outputRoot}; harness files → ${resolved.harnessDir}`,
  )
}
