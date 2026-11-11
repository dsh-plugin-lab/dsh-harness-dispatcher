/**
 * The skill this plugin registers for the agents that can use it.
 *
 * The tools are model-facing, so "how do I use this" is a prompt problem. A skill is the host's
 * mechanism for exactly that: it sits in the catalogue until an agent loads it, so the instructions cost
 * nothing until needed.
 *
 * **Registered from code, not as files**, because a filesystem skill is only visible when a preset
 * mounts a skill provider pointed at it — a preset that does not (such as `standard`) sees none of them.
 * A pointer without a fallback fails silently, so this plugin carries its own text.
 *
 * `skills` is therefore an **optional** service: no registry, no skill, everything else still works.
 *
 * @module dsh-harness-dispatcher/skill
 */

import type { Context } from '@deepseek-ai/cordis'

/** The skill's name. Kebab-case, and namespaced so it cannot collide with a user's own skill. */
export const SKILL_NAME = 'dsh-harness-bench'

/**
 * The skill registry as this module needs it. Structural, so no peer dependency on a service we only
 * use when the host happens to mount it.
 */
interface SkillRegistry {
  register(skill: {
    readonly name: string
    readonly description: string
    readonly content: string
  }): () => void
}

/**
 * The instructions. Deliberately short: the host trims a tool result above 8192 characters, and every
 * line here is paid for on load.
 */
const CONTENT = `# Benchmarking a harness

A **harness** is what a child agent runs with: its prompt and tool rows, plus the model route its
requests use. This bench runs one fixed task against one harness and records what happened. It does not
score anything — the records are the deliverable, and analysis happens outside.

## The loop (the first two steps are free)

1. **Look before you leap.** \`harness_inspect\` mounts a harness, audits it and reports what the subject
   could actually call. It starts no agent and spends no tokens.
   - To look at a harness the host already has: \`{ preset: "standard" }\` — no file needed.
   - To try a small ablation: \`{ harness: { tools: ["fs"] } }\`.
   - To check a file you wrote: \`{ harness: { file: "minus-web" } }\`.
   Read the reply: \`ok\` means it can serve as a subject. \`problems\` lists rows that mounted but
   contribute nothing, an unreachable fault, or an unusable model route.
2. **Start from something that runs.** \`harness_export { preset: "standard", name: "minus-web" }\`
   writes a working row list. Edit it with your file tools: delete rows, change \`config\`, add
   \`disabled\`, group rows with \`isolate\`. It is a Loader entry list, parsed by the host itself.
3. **Run it.** \`harness_run { task_id, prompt, trials, harness: { file: "minus-web" } }\`.
4. **Change one thing and repeat.** Keep \`task_id\` and \`prompt\` **byte-identical** between harnesses.
   That is the whole experiment.

## Four traps, in the order people hit them

- **A harness is a delta, not a world.** By default the subject also inherits every tool the host mounts
  for itself. Add \`sealed: true\` and it sees only what its rows declare — without it you are comparing
  two harnesses that share forty tools you never chose.
- **Two namespaces.** \`harness.tools\` takes CATALOGUE KEYS (\`fs\`, \`pwsh\`); \`faults[].tool\` takes
  MODEL-FACING TOOL NAMES (\`read\`, \`grep\`). A fault naming a catalogue key never fires, and a fault that
  never fires still produces a clean-looking record.
- **Faults are not part of the harness.** They sit beside it, on the tool pipelines. So the same harness
  file can be run under different faults, and "same harness, different fault" is two variables, not one.
- **Compare by \`stimulus.fingerprint\`, never by file name.** It covers the harness content plus the route
  and the delegation depth. Two runs with equal fingerprints applied the same thing; two with different
  ones did not, whatever the files are called.

## What the records say

- \`trace\` — what the subject DID: turns, steps, tool calls, per-tool errors, token accounting, final text.
- \`modelInput\` — what it WAS GIVEN: the rendered system prompt (digest and length), the assembled tool
  schemas, the route actually used. This is why "the same harness" is checkable rather than trusted.
- \`surface\` (in \`run.json\`) — what the harness mounted with: every row's enablement plus the tool and
  skill names callable in the subject's scope.

## Do not

- Do not compute means, intervals or p-values in conversation and call it a result. Export the JSONL.
- Do not vary the task between harnesses. The task is the controlled variable.
- Do not put credentials in a harness file. It is copied verbatim into the run directory.
`

/** Routing text; the only part of a skill the model sees before loading it. */
const DESCRIPTION =
  'How to use this bench: inspect a harness for free, export a working one to edit, run a task ' +
  'against it, and read the records. Covers the two tool-name namespaces and why runs are compared ' +
  'by fingerprint.'

/**
 * Register the skill, when the host has a skill registry.
 *
 * The registration is owned by this plugin's fiber. `register()` files its disposer under the
 * **registry's** context, so a caller that discards the return value leaves the entry alive after the
 * plugin unloads — and a reload then hits "already registered", keeps the previous body, and reports
 * nothing: an edit that looks applied and is not.
 *
 * A failure is logged and not thrown: the tools are the bench, the skill only explains them, so a
 * profile that cannot take the skill must still get a working bench.
 *
 * @param ctx - the plugin's context.
 * @returns whether the skill was registered; `false` means no registry, or the registration threw.
 */
export function registerSkill(ctx: Context): boolean {
  const skills: SkillRegistry | undefined = ctx.get('skills')
  if (skills === undefined) {
    ctx.logger.info(
      'harness-dispatcher: no skill registry in this profile, so the usage skill was not registered',
    )
    return false
  }
  try {
    ctx.effect(
      () => skills.register({ name: SKILL_NAME, description: DESCRIPTION, content: CONTENT }),
      'harness.skill',
    )
  } catch (error) {
    ctx.logger.warn(`harness-dispatcher: the usage skill was not registered: ${String(error)}`)
    return false
  }
  return true
}
