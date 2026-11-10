import { describe, expect, it } from 'vitest'
import { catalogLine, DEFAULT_TOOLS, TOOL_CATALOG, TOOL_KEYS } from '../src/catalog.ts'

/**
 * The catalog is the closed vocabulary a Harness variant may name. These tests exist because the
 * plugin's own load-time validation once used `'fs' in TOOL_KEYS` — an operator that tests *property
 * names* on a `Set`, which is always false. Every default key was rejected and the plugin refused to
 * activate. Types and the rest of the suite were silent about it; only installing caught it.
 */
describe('catalog', () => {
  it('exposes the default tools as real catalog keys', () => {
    // Membership must be tested with `has`, and the defaults must satisfy it.
    for (const key of DEFAULT_TOOLS) {
      expect(TOOL_KEYS.has(key), `default tool "${key}" is not a catalog key`).toBe(true)
    }
  })

  it('answers `has` for every catalog key and for no other string', () => {
    for (const key of Object.keys(TOOL_CATALOG)) expect(TOOL_KEYS.has(key)).toBe(true)
    expect(TOOL_KEYS.has('wite')).toBe(false)
    expect(TOOL_KEYS.has('')).toBe(false)
    // Guards the exact bug: the `in` operator would answer differently, so assert the trap stays shut.
    expect(Object.hasOwn(TOOL_KEYS, 'fs')).toBe(false)
  })

  it('gives every entry a provider module id and a summary', () => {
    for (const [key, entry] of Object.entries(TOOL_CATALOG)) {
      expect(entry.name, key).toMatch(/^@deepseek-ai\/dsh-/)
      expect(entry.summary.length, key).toBeGreaterThan(0)
    }
  })

  it('renders one line that names every key', () => {
    const line = catalogLine()
    for (const key of Object.keys(TOOL_CATALOG)) expect(line).toContain(key)
  })
})
