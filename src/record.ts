/**
 * One trial, one line. Plain JSONL on disk, nothing else.
 *
 * There is deliberately no query API, no aggregation and no statistics here — see
 * docs/ARCHITECTURE.md §4.4. The moment this module grows a `mean()`, the analysis口径 lives inside
 * the plugin, and the data stops being recomputable under a different one.
 *
 * @module dsh-harness-dispatcher/record
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessSpec } from './harness.ts'
import type { TraceFeatures } from './trace.ts'

/** Why a trial's run ended, as the subagent runtime reports it. */
export type TrialStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** One trial's durable record: the stimulus, the outcome, and the folded trace. */
export interface TrialRecord {
  /** Identity of the benchmark run this trial belongs to. */
  readonly runId: string
  /** 1-based trial index within the run. */
  readonly trial: number
  /** The Harness variant that was applied. Two records are comparable iff these are equal. */
  readonly harness: HarnessSpec
  /** Task identity; part of the controlled input. */
  readonly taskId: string
  /** The subject Session id, so the raw log can be found again. */
  readonly childId: string
  /** Wall-clock start, epoch milliseconds. */
  readonly startedAt: number
  /** Wall-clock end, epoch milliseconds. */
  readonly endedAt: number
  /** Elapsed wall time. Wall time is a measurement, not a statistic. */
  readonly wallMs: number
  /** Terminal reason. Recorded as data: a broken subject is an observation, not an exception. */
  readonly stopReason: TrialStopReason
  /** Provider-authored failure detail, when the runtime supplied one. */
  readonly diagnostic: string | null
  /** The subject's final text, truncated. */
  readonly output: string
  /** Folded trace features, or `null` when the log was already gone at settle time. */
  readonly trace: TraceFeatures | null
  /** Set when the trace could not be read, so a missing trace is never mistaken for a zero trace. */
  readonly traceUnavailableReason: string | null
}

/** Metadata for a freshly opened run. */
export interface RunMeta {
  /** Run identity, also the directory name. */
  readonly runId: string
  /** When the run started, epoch milliseconds. */
  readonly startedAt: number
  /** The task set identity, so records from different task sets are never pooled by accident. */
  readonly taskId: string
  /** Operator's note; free text, not interpreted. */
  readonly note: string | null
}

/** A run's on-disk home. */
export interface RunHandle {
  /** Run identity. */
  readonly runId: string
  /** Directory holding the records and the run metadata. */
  readonly directory: string
  /** Absolute path of the JSONL record file. */
  readonly recordPath: string
  /** Append one trial. Resolves after the line is flushed. */
  append(record: TrialRecord): Promise<void>
}

/**
 * Create a run directory.
 *
 * `w` (write, truncate) is deliberately not used and the file is created with `flag: 'a'` semantics:
 * a run id that already exists must be a caller error, because silently appending to a previous run's
 * file would mix two experiments into one file that still looks well-formed.
 *
 * @param root - parent directory for run directories.
 * @param meta - run metadata; written once as `run.json`.
 * @returns the handle used to append trial records.
 */
export async function openRun(root: string, meta: RunMeta): Promise<RunHandle> {
  const directory = join(root, meta.runId)
  await mkdir(directory, { recursive: true })
  const recordPath = join(directory, 'trials.jsonl')
  // `wx` fails when the file exists — the guard against collapsing two runs into one file.
  await writeFile(recordPath, '', { flag: 'wx' })
  await writeFile(
    join(directory, 'run.json'),
    `${JSON.stringify({ ...meta, recordSchema: 1 }, null, 2)}\n`,
    'utf8',
  )
  return {
    runId: meta.runId,
    directory,
    recordPath,
    async append(record: TrialRecord): Promise<void> {
      await appendFile(recordPath, `${JSON.stringify(record)}\n`, 'utf8')
    },
  }
}
