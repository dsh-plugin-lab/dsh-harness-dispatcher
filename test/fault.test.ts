import { describe, expect, it } from 'vitest'
import { FaultSpecError, assertFaultsReachable, normalizeFaults } from '../src/fault.ts'

/**
 * Faults are an independent variable, so they live outside the composition — and a fault that can never
 * fire produces a well-formed record of a condition that was never applied. These tests hold that line.
 */
describe('faults', () => {
  it('accepts exactly deny, fail and latency', () => {
    for (const mode of ['deny', 'fail', 'latency'] as const) {
      expect(normalizeFaults([{ tool: 'read', mode }])[0]?.mode).toBe(mode)
    }
    expect(() => normalizeFaults([{ tool: 'read', mode: 'error' as 'fail' }])).toThrow(
      /must be one of/,
    )
  })

  it('defaults a message per mode, because the message is part of the stimulus', () => {
    expect(normalizeFaults([{ tool: 'read', mode: 'fail' }])[0]?.message).toMatch(/failed/)
    expect(normalizeFaults([{ tool: 'read', mode: 'latency' }])[0]?.latencyMs).toBe(1500)
  })

  it('refuses contradictory faults on one tool rather than letting the last win', () => {
    expect(() =>
      normalizeFaults([
        { tool: 'read', mode: 'deny' },
        { tool: 'read', mode: 'fail' },
      ]),
    ).toThrow(/contradictory/)
  })

  it('rejects latencyMs outside the latency mode, and a zero or absurd delay', () => {
    expect(() => normalizeFaults([{ tool: 'read', mode: 'deny', latencyMs: 900 }])).toThrow(
      /belongs to mode/,
    )
    expect(() => normalizeFaults([{ tool: 'read', mode: 'latency', latencyMs: 0 }])).toThrow(
      /positive integer/,
    )
    expect(() => normalizeFaults([{ tool: 'read', mode: 'latency', latencyMs: 90_000 }])).toThrow(
      /at most/,
    )
  })

  it('rejects a fault no tool of the composition could receive', () => {
    // The defect: `faults: [{tool:'fs'}]` names a catalogue key, matches no tool, and the run looks
    // like a clean baseline while claiming a condition that never happened.
    expect(() =>
      assertFaultsReachable(normalizeFaults([{ tool: 'fs', mode: 'fail' }]), ['read']),
    ).toThrow(FaultSpecError)
  })

  it('names what was actually callable, so the caller can see the two namespaces', () => {
    try {
      assertFaultsReachable(normalizeFaults([{ tool: 'wite', mode: 'fail' }]), ['read', 'write'])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(String(error)).toContain('read, write')
      expect(String(error)).toContain('"wite"')
    }
  })

  it('passes a reachable fault through untouched', () => {
    expect(() =>
      assertFaultsReachable(normalizeFaults([{ tool: 'read', mode: 'fail' }]), ['read']),
    ).not.toThrow()
  })
})
