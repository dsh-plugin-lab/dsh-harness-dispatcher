/**
 * The shortcut: a handful of scalars compiled into harness rows.
 *
 * A harness under test is a **row list** (see `.agents/notes/2026-11-11-harness-shape.md`). Most
 * ablations are small ("the same thing minus the web tools"), so this compiles them to rows and
 * **produces a file too**, captured into the run directory like an authored one.
 *
 * There is no second execution path: shortcut rows and file rows go through the same mount, audit and
 * probe, and only `source` says which door they came through.
 *
 * Faults, the task and the model route are not here — keeping this module harness-only is what makes
 * "one variable at a time" checkable.
 *
 * @module dsh-harness-dispatcher/shortcut
 */

import { PERSONAS, PERSONA_ROW, TOOL_CATALOG } from './catalog.ts'
import type { Vocabulary } from './catalog.ts'
import type { HarnessRow } from './harness.ts'

/** Persona variants the shortcut ships. A harness file can carry any prose it likes. */
export type PersonaVariant =
  /** No persona row at all — the deployment persona applies untouched. */
  | 'none'
  | 'terse'
  | 'verbose'
  | 'pair-programmer'
  /** Caller-supplied prose; bounded, and recorded verbatim in the run metadata. */
  | 'custom'

/**
 * A shortcut as a caller may pass it.
 *
 * **Harness only.** The model route and the delegation budget are *request-level* — they cannot be
 * written into a row list at all, so they sit beside the harness rather than inside either form.
 */
export interface ShortcutInput {
  readonly tools?: readonly string[] | undefined
  readonly persona?: PersonaVariant | undefined
  /** Used only with `persona: 'custom'`. */
  readonly personaText?: string | undefined
}

/** A validated shortcut, ready to compile. */
export interface ShortcutSpec {
  /** Catalogue keys this variant mounts, sorted. */
  readonly tools: readonly string[]
  /** Resolved persona prose, or `null` when the variant mounts no persona row. */
  readonly persona: string | null
  /** Which persona variant produced {@link ShortcutSpec.persona}. Part of the harness identity. */
  readonly personaVariant: PersonaVariant
}

/** Deployment defaults for omitted fields. */
export interface ShortcutDefaults {
  readonly tools: readonly string[]
}

/** Longest accepted custom persona, in characters. */
const MAX_PERSONA_TEXT = 4000

/** Error raised for a shortcut that cannot be run. */
export class ShortcutError extends Error {
  override readonly name = 'ShortcutError'
}

/**
 * Validate one caller-supplied shortcut.
 *
 * @param input - the shortcut, as passed.
 * @param defaults - deployment defaults for omitted fields.
 * @param vocabulary - the catalogue: which keys exist.
 * @returns the validated shortcut.
 * @throws {ShortcutError} when a field is internally inconsistent or names an unknown catalogue key.
 */
export function normalizeShortcut(
  input: ShortcutInput,
  defaults: ShortcutDefaults,
  vocabulary: Vocabulary,
): ShortcutSpec {
  const personaVariant = input.persona ?? 'none'
  const persona = resolvePersona(personaVariant, input.personaText)

  // Sorted, because the order a caller typed is an artifact of typing, not an intent: row order is
  // owned by `shortcutRows` (persona first, then tools), so two shortcuts naming the same tools must
  // produce the same harness and the same digest.
  const tools = [...new Set(input.tools ?? defaults.tools)].sort()
  // `tools: []` is accepted, and that is a correction: this function used to throw while the comment
  // right above it called an empty tool set "a legitimate ablation", so the advice it gave ("pass tools
  // explicitly to ablate") failed when followed. What a zero-tool harness *is* — an endpoint, not a
  // mistake — is decided where the surface is observed, not here: `emptySurfaceVerdict` in
  // [subject.ts](subject.ts) blocks a harness whose rows were all denied and warns about one that
  // declares none. Measured 2026-11-12.
  const unknown = tools.filter((key) => !vocabulary.keys.has(key))
  if (unknown.length > 0) {
    throw new ShortcutError(
      `unknown tool key(s) ${unknown.map((key) => `"${key}"`).join(', ')}; ` +
        `known: ${[...vocabulary.keys].sort().join(', ')}. ` +
        'These are CATALOGUE KEYS such as "fs", not model-facing tool names such as "read".',
    )
  }

  return { tools, persona, personaVariant }
}

function resolvePersona(variant: PersonaVariant, text: string | undefined): string | null {
  if (variant === 'custom') {
    const trimmed = text?.trim() ?? ''
    if (trimmed === '') {
      throw new ShortcutError('persona "custom" requires a non-empty persona_text')
    }
    if (trimmed.length > MAX_PERSONA_TEXT) {
      throw new ShortcutError(`persona_text must be at most ${String(MAX_PERSONA_TEXT)} characters`)
    }
    return trimmed
  }
  if (text !== undefined) {
    throw new ShortcutError('persona_text is only meaningful with persona "custom"')
  }
  return variant === 'none' ? null : PERSONAS[variant]
}

/**
 * Compile a shortcut into harness rows.
 *
 * Row order is load order and therefore semantics: the persona row must exist before the system prompt
 * is assembled, and tool rows must precede any row that inspects the tool registry. This function owns
 * that order so no caller can get it wrong.
 *
 * @param spec - the validated shortcut.
 * @returns rows in load order.
 */
export function shortcutRows(spec: ShortcutSpec): HarnessRow[] {
  const rows: HarnessRow[] = []
  if (spec.persona !== null) {
    rows.push({ id: 'bench-persona', name: PERSONA_ROW, config: { prefix: spec.persona } })
  }
  for (const key of spec.tools) {
    const entry = TOOL_CATALOG[key]
    if (entry === undefined) throw new ShortcutError(`shortcut names an unknown key "${key}"`)
    rows.push({
      // Derived from the catalogue key, so a diff between two harnesses is readable.
      id: `bench-tool-${key}`,
      name: entry.name,
      ...(entry.config === undefined ? {} : { config: entry.config }),
    })
  }
  return rows
}

/**
 * One-line human label, used as the mounted preset's display name.
 * @param spec - the validated shortcut.
 * @returns a short description.
 */
export function shortcutLabel(spec: ShortcutSpec): string {
  return `shortcut(tools=${spec.tools.join(',')}, persona=${spec.personaVariant})`
}
