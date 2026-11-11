/**
 * The skill this plugin registers for the agents that can use it.
 *
 * ## Why a skill, and why registered from code
 *
 * The tools are model-facing, so "how do I use this" is a *prompt* problem, not a README problem. A
 * skill is the host's mechanism for exactly that: it sits in the skill catalogue until an agent loads
 * it, so the instructions cost nothing until they are needed.
 *
 * **Registered from code rather than as a directory of files**, because a filesystem skill is only
 * visible when a preset mounts a skill provider pointed at it. `cordis-plugin-development`'s own note
 * says the same thing about the shipped skills: they appear in the catalogue because the `cordis` preset
 * points `skill-filesystem` at the package, and a preset that does not (such as `standard`) sees none of
 * them. A pointer without a fallback is a dead pointer that fails silently, so this plugin carries its
 * own text instead of assuming anyone changed a profile for it.
 *
 * `skills` is therefore an **optional** service: a profile without it gets no skill and everything else
 * still works.
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

## Three traps, in the order people hit them

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

/**
 * Register the skill, when the host has a skill registry.
 *
 * @param ctx - the plugin's context.
 * @returns whether the skill was registered; `false` means this profile mounts no skill registry.
 */
export function registerSkill(ctx: Context): boolean {
  const skills: SkillRegistry | undefined = ctx.get('skills')
  if (skills === undefined) {
    ctx.logger.info(
      'harness-dispatcher: no skill registry in this profile, so the usage skill was not registered',
    )
    return false
  }
  skills.register({
    name: SKILL_NAME,
    description:
      'How to use this bench: inspect a harness for free, export a working one to edit, run a task ' +
      'against it, and read the records. Covers the two tool-name namespaces and why runs are compared ' +
      'by fingerprint.',
    content: CONTENT,
  })
  return true
}
