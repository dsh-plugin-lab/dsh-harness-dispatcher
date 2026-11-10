import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldEvent, emptyTrace, finishTrace, summarize } from '../src/trace.ts'
import type { TraceState } from '../src/trace.ts'

let seq = 0

/** Build one event with the fields the fold reads; everything else is a minimal stub. */
function ev<T extends string>(type: T, data: unknown): SessionEvent {
  seq += 1
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

const call = (callId: string, name: string) => ev('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
const okResult = (callId: string) =>
  ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [], isError: false } })
const errResult = (callId: string, code = 'ENOENT') =>
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: callId, content: [], isError: true },
    error: { name: 'ToolFailure', code },
  })
const say = (text: string, usage?: Record<string, number>) =>
  ev('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: text === '' ? [] : [{ type: 'text', text }] },
    stream: [],
    ...usage === undefined ? {} : { usage },
  })

describe('trace fold', () => {
  it('counts turns, steps, calls and per-tool errors', () => {
    const features = summarize([
      ev('turn/start', { turn: 1 }),
      ev('step/start', { turn: 1, step: 1 }),
      call('c1', 'read'),
      errResult('c1'),
      call('c2', 'read'),
      okResult('c2'),
      call('c3', 'write'),
      okResult('c3'),
      ev('step/end', { turn: 1, step: 1 }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(features.turns).toBe(1)
    expect(features.steps).toBe(1)
    expect(features.toolCalls).toBe(3)
    expect(features.toolErrors).toBe(1)
    // The error is attributed to the tool that issued the call, not to the result.
    expect(features.byTool.read).toEqual({ calls: 2, errors: 1 })
    expect(features.byTool.write).toEqual({ calls: 1, errors: 0 })
    expect(features.turnEndReasons).toEqual(['completed'])
    // The last tool result was a success, so the failure was recovered.
    expect(features.endedOnUnrecoveredError).toBe(false)
  })

  it('flags a run that ended with the failure standing', () => {
    const features = summarize([
      call('c1', 'read'),
      okResult('c1'),
      call('c2', 'write'),
      errResult('c2', 'EPERM'),
    ])
    expect(features.endedOnUnrecoveredError).toBe(true)
    expect(features.lastToolErrorCode).toBe('EPERM')
    expect(features.lastToolErrorName).toBe('ToolFailure')
  })

  it('counts calls that never produced a result', () => {
    const features = summarize([call('c1', 'read'), call('c2', 'read'), okResult('c1')])
    expect(features.toolCalls).toBe(2)
    expect(features.unansweredCalls).toBe(1)
  })

  it('does not double-count a re-issued call id', () => {
    const features = summarize([call('c1', 'read'), call('c1', 'read'), okResult('c1')])
    expect(features.toolCalls).toBe(2)
    expect(features.unansweredCalls).toBe(0)
  })

  it('keeps the final assistant text and notes interruption', () => {
    const features = summarize([say('first'), say('second'), ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'cut' }] },
      stream: [],
      interrupted: true,
    })])
    expect(features.finalText).toBe('cut')
    expect(features.interrupted).toBe(true)
  })

  it('distinguishes a missing usage report from zero usage', () => {
    const missing = summarize([say('a')])
    expect(missing.usage).toBeNull()

    const reported = summarize([say('a', { inputTokens: 10, outputTokens: 5 }), say('b')])
    expect(reported.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // One settlement carried no usage: recorded as missing, not folded into the totals as zero.
      unreportedSettlements: 1,
    })
  })

  it('treats an empty assistant message as no final text rather than an empty string', () => {
    expect(summarize([say('')]).finalText).toBeNull()
  })

  it('truncates a very long final text', () => {
    const features = summarize([say('x'.repeat(5000))])
    expect(features.finalText).toHaveLength(2000)
  })

  it('ignores unknown event types', () => {
    const features = summarize([ev('some/future-event', { anything: true }), call('c1', 'read')])
    expect(features.toolCalls).toBe(1)
  })

  it('agrees between the incremental fold and the batch fold', () => {
    const events = [call('c1', 'read'), errResult('c1'), say('done', { inputTokens: 3, outputTokens: 4 })]
    const incremental: TraceState = emptyTrace()
    for (const event of events) foldEvent(incremental, event)
    expect(finishTrace(incremental)).toEqual(summarize(events))
  })
})
