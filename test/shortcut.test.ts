import { describe, expect, it } from 'vitest'
import { CATALOG, PERSONAS, PERSONA_ROW, TOOL_CATALOG } from '../src/catalog.ts'
import { ShortcutError, normalizeShortcut, shortcutLabel, shortcutRows } from '../src/shortcut.ts'

const DEFAULTS = { tools: ['fs'] }

/**
 * The shortcut compiles into harness rows.
 *
 * It is sugar over a harness file, so what matters is that it can only produce rows that are *meant* —
 * a typo must be an error here rather than a silently different harness later.
 */
describe('the shortcut', () => {
  it('accepts every shipped persona variant', () => {
    for (const variant of ['none', 'terse', 'verbose', 'pair-programmer'] as const) {
      expect(normalizeShortcut({ persona: variant }, DEFAULTS, CATALOG).personaVariant).toBe(
        variant,
      )
    }
  })

  it('resolves shipped persona prose, and nothing for "none"', () => {
    expect(normalizeShortcut({ persona: 'terse' }, DEFAULTS, CATALOG).persona).toBe(PERSONAS.terse)
    expect(normalizeShortcut({ persona: 'none' }, DEFAULTS, CATALOG).persona).toBeNull()
  })

  it('rejects a custom persona with no prose, and prose without the custom variant', () => {
    expect(() => normalizeShortcut({ persona: 'custom' }, DEFAULTS, CATALOG)).toThrow(ShortcutError)
    expect(() =>
      normalizeShortcut({ persona: 'custom', personaText: '   ' }, DEFAULTS, CATALOG),
    ).toThrow(/non-empty/)
    // Prose beside a shipped variant is a caller mistake: one of the two would be ignored silently.
    expect(() =>
      normalizeShortcut({ persona: 'terse', personaText: 'be nice' }, DEFAULTS, CATALOG),
    ).toThrow(/only meaningful/)
  })

  it('rejects an unknown catalogue key, naming the two namespaces', () => {
    // `read` is a model-facing tool name; `fs` is the catalogue key that furnishes it.
    expect(() => normalizeShortcut({ tools: ['read'] }, DEFAULTS, CATALOG)).toThrow(
      /CATALOGUE KEYS/,
    )
  })

  it('sorts and de-duplicates, so typing order never changes the harness', () => {
    // Row order is owned here (persona first), so a caller's list order is noise, not intent.
    expect(normalizeShortcut({ tools: ['pwsh', 'fs'] }, DEFAULTS, CATALOG).tools).toEqual([
      'fs',
      'pwsh',
    ])
    expect(normalizeShortcut({ tools: ['fs', 'fs'] }, DEFAULTS, CATALOG).tools).toEqual(['fs'])
  })

  it('refuses an empty tool set unless it is asked for explicitly', () => {
    expect(() => normalizeShortcut({ tools: [] }, DEFAULTS, CATALOG)).toThrow(/at least one tool/)
  })

  it('puts the persona row before every tool row', () => {
    // Load order is semantics: the persona must exist before the system prompt is assembled.
    const rows = shortcutRows(
      normalizeShortcut({ tools: ['fs', 'pwsh'], persona: 'terse' }, DEFAULTS, CATALOG),
    )
    expect(rows[0]?.id).toBe('bench-persona')
    expect(rows[0]?.name).toBe(PERSONA_ROW)
    expect(rows.slice(1).every((row) => row.id.startsWith('bench-tool-'))).toBe(true)
  })

  it('compiles every catalogue key to its provider module id', () => {
    for (const key of Object.keys(TOOL_CATALOG)) {
      const rows = shortcutRows(normalizeShortcut({ tools: [key] }, DEFAULTS, CATALOG))
      expect(rows[0]?.name, key).toBe(TOOL_CATALOG[key]?.name)
    }
  })

  it('labels itself so a mounted preset is identifiable', () => {
    expect(
      shortcutLabel(normalizeShortcut({ tools: ['fs'], persona: 'terse' }, DEFAULTS, CATALOG)),
    ).toBe('shortcut(tools=fs, persona=terse)')
  })
})
