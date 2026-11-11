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
requests use. This bench runs one fixed task against one harness and records what happened. It scores
nothing — the records are the deliverable, and analysis happens outside.

## The loop

0. **Ask what exists.** \`harness_inspect\` with **no arguments** lists this host's presets and marks the
   default. It is the entry point when you do not already know a preset id.
1. **Look before you leap.** Given a target, \`harness_inspect\` mounts, audits and reports what the   subject could actually call — no agent, no tokens. Three ways to name one:
   \`{ preset: "standard" }\` for a preset the host has, \`{ harness: { tools: ["fs"] } }\` for a small
   ablation, \`{ harness: { file: "minus-web" } }\` for a file you wrote. \`ok\` means it can serve as a
   subject; \`problems\` names rows that mounted but contribute nothing, unreachable faults, an
   unusable route.
2. **Start from something that runs.** \`harness_export { preset: "standard", name: "minus-web" }\`
   writes a working row list. Edit it with your file tools: delete rows, change \`config\`, add
   \`disabled\`, group rows with \`isolate\`. It is a Loader entry list, parsed by the host itself.
3. **Run it.** \`harness_run { task_id, prompt, trials, harness: { file: "minus-web" } }\`.
4. **Change one thing.** Keep \`task_id\` and \`prompt\` byte-identical between harnesses — that is the
   whole experiment.

## Shaping the subject

- **A harness is a delta, not a world.** By default the subject also inherits every tool the host
  mounts for itself. \`sealed: true\` makes the harness the whole tool set; without it you are comparing
  two harnesses that share tools you never chose.
- **Skills are the one thing sealing cannot mask.** They are reachable only through a \`skill\` tool, and
  sealing removes the host's, so a sealed harness has no skill channel at all. A harness that mounts
  \`tool-skill\` itself keeps that row, and the inherited catalogue then reaches the subject — no API
  stops that.
- **A tool can be defined in the file.** A row named \`dsh-harness-dispatcher/tool\` with config
  \`{ name, description, parameters?, result }\` stands one up. Reusing a name the host already has
  **replaces** it, which is how a shipped tool's description or parameters become a variable; a name
  another row *in this harness* uses instead fails the mount. The tool always succeeds — failure and
  latency belong to \`faults\`.
- **Persona** is \`harness.persona\` (\`none\`, \`terse\`, \`verbose\`, \`pair-programmer\`, or \`custom\` with
  \`persona_text\`), and it compiles to a row, so it is inside the fingerprint like everything else.

## Three traps that each cost an experiment

- **Two namespaces.** \`harness.tools\` takes CATALOGUE KEYS (\`fs\`, \`pwsh\`); \`faults[].tool\` takes
  MODEL-FACING TOOL NAMES (\`read\`, \`grep\`). A fault naming a catalogue key never fires — and a fault
  that never fires still leaves a clean-looking record.
- **Faults are not part of the harness.** They sit beside it, on the tool pipelines, so one harness file
  runs under different faults. "Same harness, different fault" is two variables, not one.
- **Compare by \`stimulus.fingerprint\`, never by file name.** It covers the harness content, the route
  and the delegation depth. Equal fingerprints applied the same thing; different ones did not, whatever
  the files are called.

## What the records say

- \`trace\` — what the subject DID: turns, steps, tool calls, per-tool errors, tokens, final text.
- \`modelInput\` — what it WAS GIVEN: the system prompt (digest and length), the assembled tool schemas,
  the route actually used. This is why "the same harness" is checkable rather than trusted.
- \`surface\` (in \`run.json\`) — what it mounted with: each row's enablement, plus the tool and skill
  names callable in the subject's scope.

## Do not

- Compute means, intervals or p-values in conversation and call it a result. Export the JSONL.
- Vary the task between harnesses. The task is the controlled variable.
- Put credentials in a harness file. It is copied verbatim into the run directory.
`

/** Routing text; the only part of a skill the model sees before loading it. */
const DESCRIPTION =
  'How to use this bench: list the presets this host has, inspect a harness for free, export a working ' +
  'one to edit, redefine or add a tool in the file, run a task against it, and read the records. ' +
  'Covers the two tool-name namespaces and why runs are compared by fingerprint.'

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
