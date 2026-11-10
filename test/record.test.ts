import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRun } from '../src/record.ts'
import type { TrialRecord } from '../src/record.ts'

const roots: string[] = []

/** A fresh temp root, removed after the test. */
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hdispatcher-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const META = { runId: 'run-x', startedAt: 1_700_000_000_000, taskId: 'task-1', note: null }

/** A record with only the fields the writer cares about filled in. */
function record(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    runId: 'run-x',
    trial: 1,
    harness: {
      id: 'h',
      tools: ['fs'],
      persona: null,
      faults: [],
      route: { provider: null, model: null },
      maxDepth: 1,
    },
    taskId: 'task-1',
    childId: 'child-1',
    startedAt: 1,
    endedAt: 2,
    wallMs: 1,
    stopReason: 'completed',
    diagnostic: null,
    output: 'done',
    trace: null,
    traceUnavailableReason: 'not armed',
    ...overrides,
  }
}

describe('run records', () => {
  it('writes run metadata once and one line per trial', async () => {
    const dir = await root()
    const run = await openRun(dir, META)
    await run.append(record({ trial: 1 }))
    await run.append(record({ trial: 2, stopReason: 'error' }))

    const meta = JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8')) as {
      runId: string
      recordSchema: number
    }
    expect(meta.runId).toBe('run-x')
    expect(meta.recordSchema).toBe(1)

    const lines = (await readFile(run.recordPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const parsed = lines.map((line) => JSON.parse(line) as TrialRecord)
    expect(parsed.map((entry) => entry.trial)).toEqual([1, 2])
    expect(parsed[1]?.stopReason).toBe('error')
  })

  it('refuses to reuse an existing run directory, so two runs never share one file', async () => {
    const dir = await root()
    await openRun(dir, META)
    // A silently appended run would mix two experiments into one file that still parses.
    await expect(openRun(dir, META)).rejects.toThrow()
  })
})
