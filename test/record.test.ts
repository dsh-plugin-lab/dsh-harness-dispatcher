import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG } from '../src/catalog.ts'
import { resolveHarness } from '../src/harness.ts'
import { EVENTS_FILE, openRun, stimulusRecord } from '../src/record.ts'
import type { RunMeta, TrialRecord } from '../src/record.ts'

/**
 * A run directory is self-sufficient evidence: the harness it ran, the metadata, and one line per trial.
 *
 * Two guards are the point of this file — a run directory cannot be silently reused, and a run that
 * produced nothing can be removed rather than left looking like a run that found nothing.
 */
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-harness-record-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const DEPS = {
  defaults: { tools: ['fs'], maxDepth: 1, harnessDir: '' },
  vocabulary: CATALOG,
}

async function captured() {
  return resolveHarness({ harness: { tools: ['fs'] } }, DEPS)
}

function meta(runId: string, harness: Awaited<ReturnType<typeof captured>>): RunMeta {
  return {
    runId,
    startedAt: 1,
    stimulus: stimulusRecord(harness, []),
    task: {
      taskId: 't1',
      prompt: 'do the thing',
      cwd: null,
      outputSchemaRequested: false,
      outputSchema: null,
      attachments: [],
    },
    note: null,
  }
}

function recordFor(runId: string, harness: Awaited<ReturnType<typeof captured>>): TrialRecord {
  return {
    runId,
    trial: 1,
    stimulus: stimulusRecord(harness, []),
    taskId: 't1',
    childId: 'child-1',
    startedAt: 1,
    endedAt: 2,
    wallMs: 1,
    stopReason: 'completed',
    timedOut: false,
    diagnostic: null,
    output: 'done',
    structured: undefined,
    trace: null,
    modelInput: null,
    host: null,
    hostUnavailableReason: 'nothing read the host in this fixture',
    observationsUnavailableReason: 'the collector was not armed for this session',
  }
}

describe('a run directory', () => {
  it('captures the harness verbatim, beside the records', async () => {
    const harness = await captured()
    const run = await openRun(root, meta('run-a', harness), harness.captured)
    // The evidence is on disk without the original file: that is what makes the directory self-sufficient.
    expect(await readFile(run.harnessPath, 'utf8')).toBe(harness.captured.text)
    const written = JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8')) as {
      recordSchema: number
      stimulus: { harness: { digest: string } }
    }
    expect(written.recordSchema).toBeGreaterThan(1)
    expect(written.stimulus.harness.digest).toBe(harness.captured.digest)
  })

  it('appends one line per trial', async () => {
    const harness = await captured()
    const run = await openRun(root, meta('run-b', harness), harness.captured)
    await run.append(recordFor('run-b', harness))
    await run.append({ ...recordFor('run-b', harness), trial: 2 })
    const lines = (await readFile(run.recordPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[1] ?? '{}') as { trial: number }).trial).toBe(2)
  })

  it('refuses to reuse a run id rather than mixing two experiments', async () => {
    const harness = await captured()
    await openRun(root, meta('run-c', harness), harness.captured)
    // Appending silently would produce one file that still parses, holding two experiments.
    await expect(openRun(root, meta('run-c', harness), harness.captured)).rejects.toThrow()
  })

  it('writes the raw events tagged with their trial, and only when asked', async () => {
    // The bottom layer has to stay joinable to the record it belongs to, and its absence must be an
    // absent file rather than an empty one: an empty `events.jsonl` would read as "the subject did
    // nothing", which is a claim about the run.
    const harness = await captured()
    const run = await openRun(root, meta('run-f', harness), harness.captured)
    const event = { type: 'tool/call', seq: 1, time: 5, data: { callId: 'c1', name: 'read' } }
    await run.appendEvents(1, [event as never])
    await run.appendEvents(2, [])
    const lines = (await readFile(join(run.directory, EVENTS_FILE), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ trial: 1, seq: 1, type: 'tool/call' })
  })

  it('can be removed, so a failed run leaves nothing that looks like data', async () => {
    const harness = await captured()
    const run = await openRun(root, meta('run-d', harness), harness.captured)
    await run.discard()
    await expect(readFile(run.recordPath, 'utf8')).rejects.toThrow()
  })

  it('records the observed capability surface only after it is observed', async () => {
    const harness = await captured()
    const run = await openRun(root, meta('run-e', harness), harness.captured)
    // Before probing there is no claim about the harness's capability surface at all.
    const before = JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8')) as {
      surface?: unknown
    }
    expect(before.surface).toBeUndefined()

    await run.annotate({ rows: [], tools: ['read', 'write'], skills: ['x'] })
    const after = JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8')) as {
      surface: { tools: string[] }
      stimulus: { harness: { digest: string } }
    }
    expect(after.surface.tools).toEqual(['read', 'write'])
    // Annotating must not lose the metadata written at open time.
    expect(after.stimulus.harness.digest).toBe(harness.captured.digest)
  })

  it('records the stimulus without the independent variables leaking into the fingerprint', async () => {
    const harness = await captured()
    const withFault = stimulusRecord(harness, [
      { tool: 'read', mode: 'fail', message: 'x', latencyMs: 0 },
    ])
    expect(withFault.fingerprint).toBe(harness.fingerprint)
    expect(withFault.faults).toHaveLength(1)
  })
})
