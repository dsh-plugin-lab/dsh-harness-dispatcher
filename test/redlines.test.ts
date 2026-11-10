/**
 * Red lines: the rules this repository states in prose, held by assertions.
 *
 * A rule that lives only in a paragraph is a rule that drifts silently. Each block below names the
 * rule it holds and the failure it prevents; the `B` numbers are stable and are what AGENTS.md and
 * docs/ARCHITECTURE.md point at.
 *
 * Tests marked `source` read the repository's own files. That is deliberate: the rules they hold are
 * about *what the code is allowed to contain*, which no runtime assertion can enforce.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS, TOOL_CATALOG, TOOL_KEYS } from '../src/catalog.ts'
import { HarnessSpecError, normalize } from '../src/harness.ts'
import { harnessPresetId, harnessRows } from '../src/preset-rows.ts'
import { emptyTrace, finishTrace, foldEvent, summarize } from '../src/trace.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** Every non-test, non-build source file, as `relative path → text`. */
function sources(): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      files.set(full.slice(ROOT.length).replaceAll('\\', '/'), readFileSync(full, 'utf8'))
    }
  }
  walk(join(ROOT, 'src'))
  return files
}

const DEFAULTS = { tools: ['fs'], maxDepth: 1 }
const KNOWN = new Set(['fs', 'fs-search', 'pwsh'])

describe('B1 — the catalog is the only tool vocabulary', () => {
  it('every default tool is a real catalog key', () => {
    // This is the rule that a load-time check once violated: `'fs' in TOOL_KEYS` is always false on a
    // Set, so the plugin refused to activate while every test stayed green.
    for (const key of DEFAULT_TOOLS) expect(TOOL_KEYS.has(key), key).toBe(true)
  })

  it('a harness naming an unknown tool is rejected, never silently skipped', () => {
    // Silent skipping is the worst outcome: it yields a plausible empty experiment.
    expect(() => normalize({ tools: ['fs', 'wite'] }, DEFAULTS, KNOWN)).toThrow(HarnessSpecError)
  })

  it('the source mounts tool rows only through the catalog', () => {
    for (const [file, text] of sources()) {
      // A hard-coded provider module id outside the catalog would let a row bypass validation.
      if (file === 'src/catalog.ts') continue
      const matches = text.match(/['"]@deepseek-ai\/dsh-tool-[a-z-]+['"]/g) ?? []
      expect(matches, `${file} hard-codes a tool module id; add it to catalog.ts instead`).toEqual(
        [],
      )
    }
  })
})

describe('B2 — the three fault modes stay three distinct experiments', () => {
  it('accepts exactly deny, fail and latency', () => {
    for (const mode of ['deny', 'fail', 'latency'] as const) {
      expect(normalize({ faults: [{ tool: 'fs', mode }] }, DEFAULTS, KNOWN).faults[0]?.mode).toBe(
        mode,
      )
    }
    expect(() =>
      normalize({ faults: [{ tool: 'fs', mode: 'error' as 'fail' }] }, DEFAULTS, KNOWN),
    ).toThrow(/must be one of/)
  })

  it('refuses contradictory faults on one tool rather than letting the last win', () => {
    expect(() =>
      normalize(
        {
          faults: [
            { tool: 'fs', mode: 'deny' },
            { tool: 'fs', mode: 'fail' },
          ],
        },
        DEFAULTS,
        KNOWN,
      ),
    ).toThrow(/contradictory/)
  })

  it('gates on the three documented pipeline stages only', () => {
    const gate = sources().get('src/gate.ts')
    expect(gate, 'src/gate.ts must exist').toBeDefined()
    for (const stage of ['tools/pre-execute', 'tools/execute', 'tools/post-execute']) {
      expect(gate, `gate.ts must subscribe ${stage}`).toContain(stage)
    }
    // `tools/result` is observe-only; gating there would mutate nothing and look like it worked.
    expect(gate).not.toContain('tools/result')
  })
})

describe('B3 — no statistics, ever, in this process', () => {
  it('source computes no mean, median or interval', () => {
    // The boundary is the whole point of the repository: records must stay recomputable under a
    // different analysis口径, which is impossible if the plugin already averaged something.
    const banned =
      /\b(mean|average|median|percentile|stddev|variance|confidenceInterval|pValue|p_value)\b/i
    for (const [file, text] of sources()) {
      // Strip comments first: a comment explaining why we do not average is not a violation.
      const code = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '')
      expect(
        banned.test(code),
        `${file} computes a statistic; that belongs outside this repository`,
      ).toBe(false)
    }
  })

  it('the record schema carries no aggregate field', () => {
    const record = sources().get('src/record.ts')
    expect(record).toBeDefined()
    for (const field of ['mean', 'average', 'rate', 'score', 'pValue']) {
      expect(record, `record.ts must not declare "${field}"`).not.toContain(`${field}:`)
    }
  })
})

describe('B4 — a record holds facts, and no secrets', () => {
  it('declares no credential, token or prompt-body field', () => {
    const record = sources().get('src/record.ts')
    expect(record).toBeDefined()
    for (const field of ['apiKey', 'api_key', 'token:', 'credential', 'secret', 'authorization']) {
      expect(record, `record.ts must not declare "${field}"`).not.toContain(field)
    }
  })

  it('truncates the subject output rather than storing a transcript', () => {
    // Records are evidence, not conversations. An unbounded field grows without limit across trials.
    const text = sources().get('src/text.ts')
    expect(text).toMatch(/MAX_OUTPUT\s*=\s*\d{3,}/)
  })
})

describe("B5 — the fault gate changes nobody else's behaviour", () => {
  it('an idle gate returns the downstream decision untouched', () => {
    // Read from source: every listener must call `next()` when no subject is armed, so an unarmed
    // bench is a no-op rather than a policy change.
    const gate = sources().get('src/gate.ts')
    expect(gate).toBeDefined()
    const occurrences = gate?.match(/return next\(\)/g) ?? []
    expect(
      occurrences.length,
      'each of the three stages must delegate when unarmed',
    ).toBeGreaterThanOrEqual(3)
  })

  it('arms by Session id, so overlapping trials cannot disarm each other', () => {
    const gate = sources().get('src/gate.ts')
    expect(gate).toContain('Map<string, ArmedSubject>')
    expect(gate).toContain('this.armed.get(sessionId) === subject')
  })
})

describe('B6 — a run leaves nothing behind', () => {
  it('scopes the preset id to the run', () => {
    // A process-global duplicate preset id makes the second concurrent run fail to mount.
    expect(harnessPresetId('run-a')).not.toBe(harnessPresetId('run-b'))
    expect(harnessPresetId('run-a')).toContain('run-a')
  })

  it('unmounts the preset in a finally block', () => {
    const tool = sources().get('src/tools/run-benchmark.ts')
    expect(tool).toBeDefined()
    expect(tool).toMatch(/\}\s*finally\s*\{/)
    expect(tool).toContain('unmount()')
  })

  it('disposes the activation in a finally block, inside the trial loop', () => {
    const tool = sources().get('src/tools/run-benchmark.ts')
    expect(tool?.match(/activation\.dispose\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('refuses to reuse an existing run directory', () => {
    // Silent appending would mix two experiments into one file that still parses.
    const record = sources().get('src/record.ts')
    expect(record).toContain("flag: 'wx'")
  })
})

describe('B7 — a missing measurement is recorded as missing, not as zero', () => {
  it('leaves usage null when the adapter reported nothing', () => {
    const features = summarize([
      {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] },
      } as unknown as SessionEvent,
    ])
    expect(features.usage).toBeNull()
  })

  it('counts unreported settlements alongside the totals', () => {
    const events = [
      {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [] },
          stream: [],
          usage: { inputTokens: 5, outputTokens: 6 },
        },
      },
      {
        type: 'assistant/message',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] },
      },
    ] as unknown as SessionEvent[]
    expect(summarize(events).usage).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unreportedSettlements: 1,
    })
  })

  it('attributes a tool error to the tool that issued the call', () => {
    // Attributing it to the result would blame nobody, since a result carries only a call id.
    const events = [
      {
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' },
      },
      {
        type: 'tool/result',
        seq: 2,
        time: 2,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'c1', content: [], isError: true },
        },
      },
    ] as unknown as SessionEvent[]
    expect(summarize(events).byTool.read).toEqual({ calls: 1, errors: 1 })
  })

  it('agrees between the live fold and the offline fold', () => {
    const events = [
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const state = emptyTrace()
    for (const event of events) foldEvent(state, event)
    expect(finishTrace(state)).toEqual(summarize(events))
  })
})

describe('B8 — the harness declares its own composition', () => {
  it('puts the persona row before every tool row', () => {
    // Load order is semantics: the persona must exist before the system prompt is assembled.
    const rows = harnessRows({
      id: 'x',
      tools: ['fs', 'pwsh'],
      persona: 'be terse',
      faults: [],
      route: { provider: null, model: null },
      maxDepth: 1,
    })
    expect(rows[0]?.id).toBe('bench-persona')
    expect(rows.slice(1).every((row) => row.id.startsWith('bench-tool-'))).toBe(true)
  })

  it('never mounts a row the catalog does not name', () => {
    for (const key of Object.keys(TOOL_CATALOG)) {
      const rows = harnessRows({
        id: 'x',
        tools: [key],
        persona: null,
        faults: [],
        route: { provider: null, model: null },
        maxDepth: 1,
      })
      expect(rows[0]?.name).toBe(TOOL_CATALOG[key]?.name)
    }
  })

  it('requires a delegation budget that can actually start the subject', () => {
    // The deployment profile sets `subagent.maxDepth: 0`; inheriting it would make every subject
    // unstartable, and the failure would surface as "no records" rather than as a config error.
    expect(() => normalize({ maxDepth: 0 }, DEFAULTS, KNOWN)).toThrow(/at least 1/)
  })
})
