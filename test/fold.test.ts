import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyFold, finishFold, foldEvent, summarize } from '../src/fold.ts'

/** Build a session event without dragging the host's full envelope into the test. */
function event(type: string, data: unknown, seq = 1): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

function assistant(text: string, extra: Record<string, unknown> = {}): SessionEvent {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stream: [],
    ...extra,
  })
}

/**
 * One reducer, two views. The trace says what the subject did; `modelInput` says what it was given.
 * The second view is what lets this bench claim "the same harness" without trusting a file.
 */
describe('the trace view', () => {
  it('counts turns, steps and calls', () => {
    const facts = summarize([
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('step/end', { turn: 1, step: 1 }),
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
    ])
    expect(facts.trace.turns).toBe(1)
    expect(facts.trace.steps).toBe(1)
    expect(facts.trace.toolCalls).toBe(1)
    expect(facts.trace.turnEndReasons).toEqual(['completed'])
  })

  it('attributes a tool error to the tool that issued the call', () => {
    // Attributing it to the result would blame nobody, since a result carries only a call id.
    const facts = summarize([
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: 'c1', content: [], isError: true },
      }),
    ])
    expect(facts.trace.byTool.read).toEqual({ calls: 1, errors: 1 })
    expect(facts.trace.endedOnUnrecoveredError).toBe(true)
  })

  it('leaves usage null when the adapter reported nothing', () => {
    // A missing report recorded as zero would make every terse route look infinitely cheap.
    expect(summarize([assistant('hi')]).trace.usage).toBeNull()
  })

  it('counts unreported settlements beside the totals', () => {
    const facts = summarize([
      assistant('a', { usage: { inputTokens: 5, outputTokens: 6 } }),
      assistant('b'),
    ])
    expect(facts.trace.usage).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unreportedSettlements: 1,
    })
  })

  it('keeps the final text and marks an interrupted settlement', () => {
    const facts = summarize([assistant('partial', { interrupted: true })])
    expect(facts.trace.finalText).toBe('partial')
    expect(facts.trace.interrupted).toBe(true)
  })
})

describe('the modelInput view', () => {
  it('records the rendered system prompt as a length and a digest, never as text', () => {
    const prompt = 'You are a terse engineer.'
    const facts = summarize([
      event('system/message', {
        turn: 1,
        step: 1,
        message: { role: 'system', content: [{ type: 'text', text: prompt }] },
      }),
    ])
    expect(facts.modelInput.systemPrompt).toEqual({
      chars: prompt.length,
      digest: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string,
    })
    // The body must not be in the record: records are evidence, not transcripts.
    expect(JSON.stringify(facts)).not.toContain('terse engineer')
  })

  it('takes the last prompt, and records a cleared one as cleared', () => {
    const facts = summarize([
      event('system/message', {
        turn: 1,
        step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'first' }] },
      }),
      event('system/message', {
        turn: 1,
        step: 2,
        message: { role: 'system', content: [] },
      }),
    ])
    expect(facts.modelInput.systemPrompt).toBeNull()
    expect(facts.modelInput.systemPromptUpdates).toBe(2)
  })

  it('reads the route and the tool names out of the request header', () => {
    const facts = summarize([
      event('request/header', {
        header: {
          config: { provider: 'cpa-workbuddy', model: 'wb/deepseek-v4.1-flash', maxTokens: 4096 },
          tools: [
            { name: 'read', description: 'd', parameters: { type: 'object' } },
            { name: 'grep', description: 'd', parameters: { type: 'object' } },
          ],
        },
        reason: 'initial',
      }),
    ])
    expect(facts.modelInput.route).toEqual({
      provider: 'cpa-workbuddy',
      model: 'wb/deepseek-v4.1-flash',
      reasoningEffort: null,
      maxTokens: 4096,
    })
    expect(facts.modelInput.tools).toEqual(['read', 'grep'])
    expect(facts.modelInput.toolSchemaDigest).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes the schema digest when only a signature changes', () => {
    const header = (parameters: unknown) => [
      event('request/header', {
        header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'read', parameters }] },
        reason: 'initial',
      }),
    ]
    const a = summarize(header({ type: 'object' }))
    const b = summarize(header({ type: 'object', properties: {} }))
    expect(a.modelInput.tools).toEqual(b.modelInput.tools)
    expect(a.modelInput.toolSchemaDigest).not.toBe(b.modelInput.toolSchemaDigest)
  })

  it('records a tool-less request as no tools rather than as missing', () => {
    const facts = summarize([
      event('request/header', {
        header: { config: { provider: 'p', model: 'm' } },
        reason: 'initial',
      }),
    ])
    expect(facts.modelInput.tools).toEqual([])
  })
})

describe('the fold as a whole', () => {
  it('agrees between the live fold and the offline fold', () => {
    const events = [event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
    const state = emptyFold()
    for (const item of events) foldEvent(state, item)
    expect(finishFold(state)).toEqual(summarize(events))
  })

  it('ignores an event type it does not know', () => {
    // A host that adds a session event type must not break old records; the new fact is simply uncounted.
    const facts = summarize([event('some/future-event', { anything: true })])
    expect(facts.trace.toolCalls).toBe(0)
    expect(facts.modelInput.headerSnapshots).toBe(0)
  })
})
