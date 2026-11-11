import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FoldCollector } from '../src/collector.ts'

/** A context that lets a test deliver committed events by hand, on named Session objects. */
function harness(): {
  fold: FoldCollector
  emit: (session: { id: string }, e: SessionEvent) => void
} {
  let listener: ((session: { id: string }, event: SessionEvent) => void) | undefined
  const ctx = {
    on: (name: string, fn: (session: { id: string }, event: SessionEvent) => void) => {
      expect(name).toBe('session/event')
      listener = fn
      return () => undefined
    },
  } as unknown as Context
  const fold = new FoldCollector()
  fold.attach(ctx)
  return { fold, emit: (session, event) => listener?.(session, event) }
}

const CHILD = { id: 'child-1' }
const OTHER = { id: 'child-2' }

const TOOL_CALL = {
  type: 'tool/call',
  seq: 1,
  time: 1000,
  data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
} as unknown as SessionEvent

describe('FoldCollector raw events', () => {
  it('keeps every committed event verbatim when asked', () => {
    // The bottom layer. Kept as the host emitted it — the collector's job is storage, not interpretation.
    const { fold, emit } = harness()
    const disarm = fold.arm(CHILD.id, true)
    emit(CHILD, TOOL_CALL)
    expect(fold.takeEvents(CHILD.id)).toEqual([TOOL_CALL])
    disarm()
  })

  it('keeps nothing when the caller turned recording off', () => {
    // `undefined`, not `[]`: an empty array would claim the subject emitted nothing, which is a
    // different fact from "we did not look".
    const { fold, emit } = harness()
    const disarm = fold.arm(CHILD.id, false)
    emit(CHILD, TOOL_CALL)
    expect(fold.takeEvents(CHILD.id)).toBeUndefined()
    disarm()
  })

  it('still folds when recording is off, so the record loses no aggregate', () => {
    // The two layers must be independent: turning off events must not thin out `trace`.
    const { fold, emit } = harness()
    const disarm = fold.arm(CHILD.id, false)
    emit(CHILD, TOOL_CALL)
    expect(fold.read(CHILD.id)?.trace.toolCalls).toBe(1)
    disarm()
  })

  it('remembers the Session object, because the store forgets it', () => {
    // Projections can only be read against a Session, and a trial reads after `result` settles — by
    // which time `ctx.sessions.get(id)` answers undefined. This reference is the one that survives.
    const { fold, emit } = harness()
    const disarm = fold.arm(CHILD.id, true)
    emit(CHILD, TOOL_CALL)
    expect(fold.sessionOf(CHILD.id)).toBe(CHILD)
    disarm()
    expect(fold.sessionOf(CHILD.id)).toBeUndefined()
  })

  it('gives nothing back after disarm, so a late read cannot cross trials', () => {
    const { fold, emit } = harness()
    const disarm = fold.arm(CHILD.id, true)
    emit(CHILD, TOOL_CALL)
    disarm()
    expect(fold.takeEvents(CHILD.id)).toBeUndefined()
    expect(fold.read(CHILD.id)).toBeUndefined()
  })

  it('leaves another session untouched', () => {
    // One collector serves every trial; an arm for one child must not capture another's events.
    const { fold, emit } = harness()
    const disarm = fold.arm(CHILD.id, true)
    emit(OTHER, TOOL_CALL)
    expect(fold.takeEvents(OTHER.id)).toBeUndefined()
    expect(fold.sessionOf(OTHER.id)).toBeUndefined()
    expect(fold.takeEvents(CHILD.id)).toEqual([])
    disarm()
  })
})
