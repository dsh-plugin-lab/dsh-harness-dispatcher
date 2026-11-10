import { describe, expect, it } from 'vitest'
import { HarnessSpecError, normalize } from '../src/harness.ts'

const DEFAULTS = { tools: ['fs'], maxDepth: 1 }
const KNOWN = new Set(['fs', 'fs-search', 'pwsh'])

/** The normalize call every test uses, with the shared defaults. */
function norm(input: Parameters<typeof normalize>[0]) {
  return normalize(input, DEFAULTS, KNOWN)
}

describe('harness normalize', () => {
  it('applies defaults for an empty descriptor', () => {
    const spec = norm({})
    expect(spec.tools).toEqual(['fs'])
    expect(spec.persona).toBeNull()
    expect(spec.faults).toEqual([])
    expect(spec.route).toEqual({ provider: null, model: null })
    expect(spec.maxDepth).toBe(1)
    expect(spec.id).toBe('tools=fs|persona=none')
  })

  it('rejects an unknown tool key instead of silently dropping it', () => {
    expect(() => norm({ tools: ['fs', 'wite'] })).toThrow(HarnessSpecError)
    expect(() => norm({ tools: ['wite'] })).toThrow(/unknown tool\(s\) "wite"/)
  })

  it('rejects an empty tool set unless it is genuinely empty', () => {
    expect(() => norm({ tools: [] })).toThrow(/at least one tool/)
  })

  it('deduplicates tools but keeps declaration order', () => {
    expect(norm({ tools: ['pwsh', 'fs', 'pwsh'] }).tools).toEqual(['pwsh', 'fs'])
  })

  it('resolves shipped persona prose and keeps none as null', () => {
    expect(norm({ persona: 'terse' }).persona).toMatch(/terse engineer/)
    expect(norm({ persona: 'none' }).persona).toBeNull()
  })

  it('requires prose for a custom persona and rejects prose without it', () => {
    expect(() => norm({ persona: 'custom' })).toThrow(/requires a non-empty personaText/)
    expect(() => norm({ persona: 'custom', personaText: '   ' })).toThrow(HarnessSpecError)
    expect(norm({ persona: 'custom', personaText: '  be brief  ' }).persona).toBe('be brief')
    expect(() => norm({ persona: 'terse', personaText: 'ignored' })).toThrow(/only meaningful/)
  })

  it('caps a custom persona length', () => {
    expect(() => norm({ persona: 'custom', personaText: 'x'.repeat(4001) })).toThrow(/at most 4000/)
  })

  it('defaults fault messages per mode and records latency only for latency', () => {
    const spec = norm({
      faults: [
        { tool: 'fs', mode: 'deny' },
        { tool: 'pwsh', mode: 'fail', message: 'boom' },
        { tool: 'fs-search', mode: 'latency', latencyMs: 250 },
      ],
    })
    expect(spec.faults).toEqual([
      { tool: 'fs', mode: 'deny', message: expect.stringContaining('not available'), latencyMs: 0 },
      { tool: 'pwsh', mode: 'fail', message: 'boom', latencyMs: 0 },
      { tool: 'fs-search', mode: 'latency', message: '', latencyMs: 250 },
    ])
  })

  it('rejects latency on non-latency modes and out-of-range latency', () => {
    expect(() => norm({ faults: [{ tool: 'fs', mode: 'deny', latencyMs: 10 }] })).toThrow(
      /belongs to mode/,
    )
    expect(() => norm({ faults: [{ tool: 'fs', mode: 'latency', latencyMs: 0 }] })).toThrow(
      /positive integer/,
    )
    expect(() => norm({ faults: [{ tool: 'fs', mode: 'latency', latencyMs: 60_001 }] })).toThrow(
      /at most 60000/,
    )
  })

  it('rejects contradictory faults on one tool rather than letting the last win', () => {
    expect(() =>
      norm({
        faults: [
          { tool: 'fs', mode: 'deny' },
          { tool: 'fs', mode: 'fail' },
        ],
      }),
    ).toThrow(/contradictory faults/)
    // Repeating the SAME mode is harmless.
    expect(norm({ faults: [{ tool: 'fs', mode: 'deny' }] }).faults).toHaveLength(1)
  })

  it('requires provider and model together', () => {
    expect(() => norm({ provider: 'p' })).toThrow(/together/)
    expect(() => norm({ model: 'm' })).toThrow(/together/)
    expect(norm({ provider: 'p', model: 'm' }).route).toEqual({ provider: 'p', model: 'm' })
  })

  it('rejects a maxDepth that could not start the subject', () => {
    expect(() => norm({ maxDepth: 0 })).toThrow(/at least 1/)
    expect(() => norm({ maxDepth: 1.5 })).toThrow(HarnessSpecError)
  })

  it('derives a stable id that ignores declaration order but tracks the stimulus', () => {
    const a = norm({ tools: ['fs', 'pwsh'], faults: [{ tool: 'fs', mode: 'deny' }] })
    const b = norm({ tools: ['pwsh', 'fs'], faults: [{ tool: 'fs', mode: 'deny' }] })
    expect(a.id).toBe(b.id)
    // A different stimulus must produce a different id, or records would pool across variants.
    expect(norm({ tools: ['fs', 'pwsh'] }).id).not.toBe(a.id)
    expect(norm({ tools: ['fs', 'pwsh'], persona: 'terse' }).id).not.toBe(a.id)
    expect(norm({ tools: ['fs', 'pwsh'], faults: [{ tool: 'fs', mode: 'fail' }] }).id).not.toBe(
      a.id,
    )
  })

  it('keeps a caller-supplied id verbatim and rejects an empty one', () => {
    expect(norm({ id: 'baseline' }).id).toBe('baseline')
    expect(() => norm({ id: '   ' })).toThrow(/must not be empty/)
  })
})
