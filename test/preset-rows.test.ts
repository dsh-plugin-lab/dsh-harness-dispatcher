import { describe, expect, it } from 'vitest'
import { harnessPresetId, harnessRows } from '../src/preset-rows.ts'
import type { HarnessSpec } from '../src/harness.ts'

/** A minimal spec; fields the row builder ignores are filled with neutral values. */
function spec(overrides: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    id: 'test',
    tools: ['fs'],
    persona: null,
    faults: [],
    route: { provider: null, model: null },
    maxDepth: 1,
    ...overrides,
  }
}

describe('preset rows', () => {
  it('emits no persona row when the variant asks for none', () => {
    expect(harnessRows(spec())).toEqual([{ id: 'bench-tool-fs', name: '@deepseek-ai/dsh-tool-fs' }])
  })

  it('puts the persona row first, before any tool row', () => {
    // Order is load order and therefore semantics: the persona must exist before prompt assembly.
    const rows = harnessRows(spec({ persona: 'be terse', tools: ['fs', 'pwsh'] }))
    expect(rows.map((row) => row.id)).toEqual(['bench-persona', 'bench-tool-fs', 'bench-tool-pwsh'])
    expect(rows[0]).toEqual({
      id: 'bench-persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: 'be terse' },
    })
  })

  it('passes catalog row config through', () => {
    const rows = harnessRows(spec({ tools: ['web'] }))
    expect(rows[0]?.config).toEqual({ fetch: true })
  })

  it('keeps the declared tool order so two variants diff readably', () => {
    const rows = harnessRows(spec({ tools: ['pwsh', 'fs'] }))
    expect(rows.map((row) => row.id)).toEqual(['bench-tool-pwsh', 'bench-tool-fs'])
  })

  it('rejects a catalog key that does not exist', () => {
    expect(() => harnessRows(spec({ tools: ['nope'] }))).toThrow(/unknown catalog key "nope"/)
  })

  it('scopes the preset id to the run so concurrent runs cannot collide', () => {
    expect(harnessPresetId('run-a')).toBe('bench-run-a')
    expect(harnessPresetId('run-a')).not.toBe(harnessPresetId('run-b'))
  })
})
