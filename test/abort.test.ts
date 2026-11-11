import { describe, expect, it } from 'vitest'
import { onceAborted } from '../src/abort.ts'

describe('onceAborted', () => {
  it('runs the action on abort, once, and only then', () => {
    const controller = new AbortController()
    let calls = 0
    const detach = onceAborted(controller.signal, () => {
      calls += 1
    })
    expect(calls).toBe(0)
    controller.abort()
    expect(calls).toBe(1)
    // A second abort cannot happen on an AbortSignal, but a listener left attached would still be a
    // leak on the caller's long-lived signal — and `detach` must stay safe after the action ran.
    detach()
    controller.abort()
    expect(calls).toBe(1)
  })

  it('runs immediately when the signal is already aborted', () => {
    // The budget can fire between starting the child and wiring the listener; a late listener that
    // missed the edge would leave that trial unstoppable.
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const detach = onceAborted(controller.signal, () => {
      calls += 1
    })
    expect(calls).toBe(1)
    detach()
    expect(calls).toBe(1)
  })

  it('does not run after the detacher, so an ended trial stays ended', () => {
    // One trial must not stop the next one's child: the trial disposes its own activation in a
    // `finally`, and the caller's signal keeps living for the remaining trials.
    const controller = new AbortController()
    let calls = 0
    const detach = onceAborted(controller.signal, () => {
      calls += 1
    })
    detach()
    controller.abort()
    expect(calls).toBe(0)
  })
})
