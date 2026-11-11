/**
 * Run one action when a caller's signal aborts.
 *
 * The host's `startActivation({ signal })` covers admission only: once the activation is accepted the
 * child runs on its own, so a signal-based budget that nobody listens on stops nothing. This is the
 * one place that listens, and it is a plain function so both edges — already aborted, already
 * detached — can be tested without a host.
 *
 * @module dsh-harness-dispatcher/abort
 */

/**
 * Run `act` when `signal` aborts, or immediately if it already has.
 *
 * At most once: an `AbortSignal` fires one edge, and {@link onceAborted}'s detacher removes the
 * listener before a later one could arrive.
 *
 * @param signal - the signal to watch; the caller keeps owning it.
 * @param act - what to do on abort.
 * @returns a detacher that cancels a pending call. Safe to call after `act` already ran.
 */
export function onceAborted(signal: AbortSignal, act: () => void): () => void {
  if (signal.aborted) {
    act()
    return () => {}
  }
  const handler = (): void => {
    act()
  }
  signal.addEventListener('abort', handler, { once: true })
  return () => {
    signal.removeEventListener('abort', handler)
  }
}
