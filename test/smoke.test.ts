import { describe, expect, it } from 'vitest'

import { apply, inject, name } from '../src/index.ts'

/**
 * Smoke test: the package imports and its entry point has the right shape.
 *
 * **Adapted from the template, deliberately.** The template's version also asserts `apply({})` does
 * not throw — true for a plugin that touches nothing, false for this one, whose `apply` reads
 * `ctx.tools`, `ctx.agentPresets`, `ctx.subagents`, `ctx.systemPrompt` and would throw on an empty
 * context. Asserting it here would either fail or, worse, force `apply` to grow a defensive
 * `if (ctx === undefined)` guard for a case that cannot happen in a real Loader mount.
 *
 * Per the template's own note: this is **not** a redline. Behavioural assertions live in
 * [redlines.test.ts](redlines.test.ts).
 */
describe('entry', () => {
  it('exports the plugin name', () => {
    expect(name).toBe('harness-dispatcher')
  })

  it('declares the services it requires', () => {
    // The list is load-bearing: a missing entry turns a hard dependency into a silent `undefined`.
    expect(inject).toEqual(['tools', 'agentPresets', 'subagents', 'systemPrompt'])
  })

  it('exports apply as a function', () => {
    expect(typeof apply).toBe('function')
  })
})
