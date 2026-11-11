/**
 * The skill this plugin registers for the agents that can use it.
 *
 * The tools are model-facing, so "how do I use this" is a prompt problem. A skill is the host's
 * mechanism for exactly that: it sits in the catalogue until an agent loads it, so the instructions cost
 * nothing until needed.
 *
 * **Registered from code, carried as a real skill file.** A filesystem skill is only visible when a
 * preset mounts a skill provider pointed at it — a preset that does not (such as `standard`) sees none of
 * them, and a pointer without a fallback fails silently. So the registration is code.
 *
 * The file is [skills/dsh-harness-bench/SKILL.md](../skills/dsh-harness-bench/SKILL.md), and it carries
 * its own YAML frontmatter: `name` and `description` have one home, in the file, and the file stays a
 * **valid skill file** — mountable by `dsh-skill-filesystem` if someone ever points a provider at this
 * directory. A body-only fragment would look identical and be dropped by that provider, which is exactly
 * the kind of half-reusable artifact this repository avoids.
 *
 * `skills` is therefore an **optional** service: no registry, no skill, everything else still works.
 *
 * @module dsh-harness-dispatcher/skill
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

/** The skill's name. Also the directory name, and what its frontmatter must say. */
export const SKILL_NAME = 'dsh-harness-bench'

/** File name inside the skill directory. */
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

/** Kebab-case, the grammar the host applies to skill names. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * A block scalar marker (`>-`, `|`, `|-`…).
 *
 * Writing `description: >-` and continuing on the next line is legal YAML, and this reader only takes
 * single-line scalars. Registering the literal `>-` as the description would leave the skill in the
 * catalogue with a description that routes nothing — the model's only signal, replaced by a dash.
 */
const BLOCK_SCALAR = /^[|>][+-]?$/

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

/** One skill file, split into the parts the host needs. */
export interface LoadedSkill {
  readonly name: string
  readonly description: string
  /** The Markdown after the frontmatter. */
  readonly body: string
}

/** Strip a matching pair of quotes, as YAML convention requires when a value contains `: `. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * Split a skill file into frontmatter fields and body.
 * @param raw - the file's text.
 * @returns the top-level fields and the body, or `undefined` when there is no frontmatter block.
 */
export function splitFrontmatter(
  raw: string,
): { fields: Map<string, string>; body: string } | undefined {
  const lines = raw.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return undefined

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    // Only top-level `key: value`; indented continuation lines are outside this reader's scope.
    if (line === '' || /^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    if (key !== '') fields.set(key, unquote(line.slice(colon + 1)))
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  }
}

/**
 * Read and validate the skill file.
 *
 * Every branch below refuses rather than registering something degraded. The host checks a registration
 * for `name`, `description` and the invocation flags and nothing else — a missing or empty body surfaces
 * only when a model loads the skill and gets an empty block, by which point nothing says which step broke.
 *
 * @param path - the file to read; overridable so tests can point at a fixture.
 * @returns name, description and body.
 * @throws {Error} when the file is unreadable, malformed, or empty.
 */
export function readSkill(path: string = SKILL_PATH): LoadedSkill {
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

  const parsed = splitFrontmatter(raw)
  if (parsed === undefined) {
    throw new Error(
      `${path} has no YAML frontmatter block, so it is not a valid skill file: it must open with "---", ` +
        `carry "name" and "description", and close the block with a second "---".`,
    )
  }
  const name = parsed.fields.get('name') ?? ''
  const description = parsed.fields.get('description') ?? ''
  if (!KEBAB_CASE.test(name) || name !== SKILL_NAME) {
    throw new Error(
      `${path} declares name ${JSON.stringify(name)}, which must be the kebab-case "${SKILL_NAME}" — the ` +
        `same string as this directory. A mismatch registers a skill the catalogue lists under a name ` +
        `nothing else agrees with.`,
    )
  }
  if (description === '' || BLOCK_SCALAR.test(description)) {
    throw new Error(
      `${path} needs a single-line "description": it is the only routing signal the model sees before ` +
        `loading the skill, so a block scalar such as ">-" leaves the skill present and unreachable.`,
    )
  }
  if (parsed.body === '') {
    throw new Error(
      `${path} has frontmatter but no body, which would render an empty <skill_content>.`,
    )
  }
  return { name, description, body: parsed.body }
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
 * malformed file is not mistaken for a host without skills.
 *
 * @param ctx - the plugin's context.
 * @param skill - an already-loaded skill; read from disk when omitted, so tests can pass a fixture.
 * @returns whether the skill was registered; `false` means no registry, or the registration failed.
 */
export function registerSkill(ctx: Context, skill?: LoadedSkill): boolean {
  const skills: SkillRegistry | undefined = ctx.get('skills')
  if (skills === undefined) {
    ctx.logger.info(
      'harness-dispatcher: no skill registry in this profile, so the usage skill was not registered',
    )
    return false
  }

  let loaded: LoadedSkill
  try {
    loaded = skill ?? readSkill()
  } catch (error) {
    ctx.logger.warn(`harness-dispatcher: the usage skill was not registered: ${String(error)}`)
    return false
  }

  try {
    ctx.effect(
      () =>
        skills.register({
          name: loaded.name,
          description: loaded.description,
          content: loaded.body,
        }),
      'harness.skill',
    )
  } catch (error) {
    ctx.logger.warn(`harness-dispatcher: the usage skill was not registered: ${String(error)}`)
    return false
  }
  return true
}
