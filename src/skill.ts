/**
 * The skill this plugin registers for the agents that can use it.
 *
 * The tools are model-facing, so "how do I use this" is a prompt problem. A skill is the host's
 * mechanism for exactly that: it sits in the catalogue until an agent loads it, so the instructions cost
 * nothing until needed.
 *
 * **Registered from code, carried as a file.** A filesystem skill is only visible when a preset mounts a
 * skill provider pointed at it — a preset that does not (such as `standard`) sees none of them, and a
 * pointer without a fallback fails silently. So the registration is code. But the *body* is
 * [SKILL.md](../skills/dsh-harness-bench/SKILL.md), read at apply time, because prose belongs in a file
 * a human reviews and diffs, not in a template literal inside a bundler's input. Editing it needs no
 * rebuild; a missing one fails loudly instead of shipping an empty skill.
 *
 * `skills` is therefore an **optional** service: no registry, no skill, everything else still works.
 *
 * @module dsh-harness-dispatcher/skill
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

/** The skill's name. Kebab-case, and namespaced so it cannot collide with a user's own skill. */
export const SKILL_NAME = 'dsh-harness-bench'

/** File name inside the skill directory. The host strips frontmatter; this body has none. */
const SKILL_FILE = 'SKILL.md'

/**
 * This module's directory: `src/` while tests run from source, `lib/` in the built package.
 *
 * Both sit one level under the package root, so `../skills` is the same path either way. Two levels
 * would be wrong from `src/skill.ts` and right only by accident from a nested build layout — and a wrong
 * root does not crash, it reports a missing file, which is the failure this module exists to prevent.
 */
const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  SKILL_NAME,
  SKILL_FILE,
)

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

/** Routing text; the only part of a skill the model sees before loading it. */
const DESCRIPTION =
  'How to use this bench: list the presets this host has, inspect a harness for free, export a working ' +
  'one to edit, redefine or add a tool in the file, run a task against it, and read the records. ' +
  'Covers the two tool-name namespaces and why runs are compared by fingerprint.'

/**
 * Read the instructions.
 *
 * **No silent empty body.** The host does not validate `content`, so registering an empty one produces a
 * skill that looks present in the catalogue and renders nothing when loaded — a failure with no
 * diagnostic anywhere. Reading it here, and refusing, keeps that from happening.
 * @param path - the file to read; overridable so tests can point at a fixture.
 * @returns the body, trimmed.
 * @throws {Error} when the file cannot be read or holds no body.
 */
export function readSkillBody(path: string = SKILL_PATH): string {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `the usage skill could not be read at ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
        `It ships with the package (the files whitelist in package.json includes "skills"), so a missing ` +
        `one means the build output is not where this module expects it.`,
      { cause: error },
    )
  }
  const body = raw.trim()
  if (body === '')
    throw new Error(`${path} is empty, which would register a skill that renders nothing`)
  return body
}

/**
 * Register the skill, when the host has a skill registry.
 *
 * The registration is owned by this plugin's fiber. `register()` files its disposer under the
 * **registry's** context, so a caller that discards the return value leaves the entry alive after the
 * plugin unloads — and a reload then hits "already registered", keeps the previous body, and reports
 * nothing: an edit that looks applied and is not.
 *
 * A failure is logged and not thrown: the tools are the bench, the skill only explains them, so a
 * profile that cannot take the skill must still get a working bench. The log line names the cause, so a
 * broken body is not mistaken for a host without skills.
 *
 * @param ctx - the plugin's context.
 * @param body - the instructions; read from disk when omitted, so tests can pass a fixture.
 * @returns whether the skill was registered; `false` means no registry, or the registration failed.
 */
export function registerSkill(ctx: Context, body?: string): boolean {
  const skills: SkillRegistry | undefined = ctx.get('skills')
  if (skills === undefined) {
    ctx.logger.info(
      'harness-dispatcher: no skill registry in this profile, so the usage skill was not registered',
    )
    return false
  }

  let content: string
  try {
    content = body ?? readSkillBody()
  } catch (error) {
    ctx.logger.warn(`harness-dispatcher: the usage skill was not registered: ${String(error)}`)
    return false
  }

  try {
    ctx.effect(
      () => skills.register({ name: SKILL_NAME, description: DESCRIPTION, content }),
      'harness.skill',
    )
  } catch (error) {
    ctx.logger.warn(`harness-dispatcher: the usage skill was not registered: ${String(error)}`)
    return false
  }
  return true
}
