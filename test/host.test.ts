import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HOST_KEYS, readHost } from '../src/host.ts'

/** A context whose service lookups answer from a plain map. */
function fakeCtx(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

const SESSION = { id: 'child-1' }
const STATS = {
  turns: 2,
  steps: 3,
  llmMs: 100,
  toolMs: 20,
  ttftMs: 40,
  ttftSteps: 3,
  decodeMs: 50,
  decodeTokens: 7,
}

describe('readHost', () => {
  it('returns the values exactly as the host produced them', () => {
    // The whole point of this module: a value that came back from a projection is not re-derived, not
    // rounded, and not renamed. A test that asserted an equal shape would pass on a fold of my own.
    const values = { sessionStats: STATS, tokenUsage: { outputTokens: 11 } }
    const ctx = fakeCtx({
      sessionProjections: {
        snapshot: (session: unknown, keys: readonly string[]) => {
          expect(session).toBe(SESSION)
          // Only the declared keys are asked for: an unrelated projection is not this bench's business.
          expect(keys).toEqual([...HOST_KEYS])
          return { asOfSeq: 42, values }
        },
      },
    })
    expect(readHost(ctx, SESSION)).toEqual({ ok: true, asOfSeq: 42, values })
  })

  it('records which cut the numbers describe', () => {
    // `sessionStats.turns` read mid-turn and read after settlement are different facts. Without the seq
    // a reader cannot tell a partial figure from a final one.
    const ctx = fakeCtx({
      sessionProjections: { snapshot: () => ({ asOfSeq: 7, values: {} }) },
    })
    const read = readHost(ctx, SESSION)
    expect(read.ok && read.asOfSeq).toBe(7)
  })

  it('says why values are missing — never a bare null, never zeros', () => {
    // A zero would read as "the host computed nothing", which is a claim about the run. The two reasons
    // are different findings: no registry means stop looking, no Session means we asked too late.
    const noRegistry = readHost(fakeCtx({}), SESSION)
    expect(noRegistry.ok).toBe(false)
    expect(noRegistry.ok ? '' : noRegistry.reason).toContain('no projection registry')

    const noSession = readHost(fakeCtx({}), undefined)
    expect(noSession.ok ? '' : noSession.reason).toContain('emitted no events')
  })

  it('does not lose the trial when a projection refuses to fold', () => {
    const ctx = fakeCtx({
      sessionProjections: {
        snapshot: () => {
          throw new Error('stateVersion mismatch')
        },
      },
    })
    const read = readHost(ctx, SESSION)
    expect(read.ok).toBe(false)
    expect(read.ok ? '' : read.reason).toContain('stateVersion mismatch')
  })

  it('reads the Session it is handed, without a store lookup', () => {
    // Measured on host 0.2.2-rc.1: `result` settles after teardown, so `ctx.sessions.get(childId)`
    // answered undefined by the time a trial could read anything, and every record said `host: null`
    // while its events were landing normally. The Session object outlives that lookup.
    let asked: unknown
    const ctx = fakeCtx({
      // A store that would answer "gone" if anything consulted it.
      sessions: { get: () => undefined },
      sessionProjections: {
        snapshot: (session: unknown) => {
          asked = session
          return { asOfSeq: 1, values: { sessionStats: STATS } }
        },
      },
    })
    expect(readHost(ctx, SESSION).ok).toBe(true)
    expect(asked).toBe(SESSION)
  })
})

describe('HOST_KEYS', () => {
  it('names the timing projection and no key this bench derives itself', () => {
    // The list is the contract with the host: adding a projection is one string here. `turns`, `steps`
    // and the token buckets live inside `sessionStats`/`tokenUsage` rather than as keys of their own.
    expect(HOST_KEYS).toContain('sessionStats')
    expect(HOST_KEYS).toContain('tokenUsage')
    expect(HOST_KEYS).toContain('permissions')
    expect(new Set(HOST_KEYS).size).toBe(HOST_KEYS.length)
  })
})
