/**
 * One run, on disk: the captured harness, the run metadata, a reader's note, and one line per trial.
 *
 * No query API, no aggregation, no statistics — the moment a `mean()` appears here, the analysis口径
 * lives inside the plugin and the data stops being recomputable under a different one.
 *
 * The harness is copied in verbatim so the directory is self-sufficient evidence: hand it to someone
 * and they can see what the subject was assembled from without hunting for a file that may have moved.
 * Same in-memory capture as the mount ([harness.ts](harness.ts)), written under a stem that never
 * varies so tooling finds it, with a truthful extension so the host can parse it on replay.
 *
 * The copy is verbatim, and a row's `config` can hold anything — including credentials. A harness file
 * therefore must not carry secrets: whatever is in it lands in the evidence.
 *
 * @module dsh-harness-dispatcher/record
 */

import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fault } from './fault.ts'
import type { ObservedModelInput, TraceFeatures } from './fold.ts'
import type { CapturedHarness, ResolvedHarness } from './harness.ts'
import type { CapabilitySurface } from './subject.ts'

/** Why a trial's run ended, as the subagent runtime reports it. */
export type TrialStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** The stimulus one trial was run under, at the identity level. */
export interface StimulusRecord {
  /** Machine identity of the stimulus: harness digest + route + depth. Faults are outside it. */
  readonly fingerprint: string
  readonly harness: {
    readonly source: CapturedHarness['source']
    /** Absolute source path; `null` for the shortcut. */
    readonly originPath: string | null
    /** Captured file name inside the run directory. */
    readonly fileName: string
    /** Digest of the captured bytes. */
    readonly digest: string
  }
  readonly route: { readonly provider: string; readonly model: string } | null
  readonly maxDepth: number
  readonly faults: readonly Fault[]
}

/** The task one run holds fixed. Part of the controlled input, not a variable. */
export interface TaskRecord {
  readonly taskId: string
  readonly prompt: string
  /** Initial working directory the subject was started in, when one was requested. */
  readonly cwd: string | null
  /** Whether a structured answer was requested. The schema itself is in the run metadata. */
  readonly outputSchemaRequested: boolean
}

/** One trial's durable record: the stimulus, the outcome, and the two folded views. */
export interface TrialRecord {
  /** Identity of the benchmark run this trial belongs to. */
  readonly runId: string
  /** 1-based trial index within the run. */
  readonly trial: number
  /** The harness variant that was applied. Two records are comparable iff these are equal. */
  readonly stimulus: StimulusRecord
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
  /** Whether this trial ended because its own timeout fired, rather than the caller's signal. */
  readonly timedOut: boolean
  /** Provider-authored failure detail, when the runtime supplied one. */
  readonly diagnostic: string | null
  /** The subject's final text, truncated. */
  readonly output: string
  /** The subject's structured answer, when the task requested a schema. */
  readonly structured: unknown
  /** What the subject did. `null` when the fold was already gone at settle time. */
  readonly trace: TraceFeatures | null
  /** What the subject was given. `null` under the same condition as {@link TrialRecord.trace}. */
  readonly modelInput: ObservedModelInput | null
  /** Set when the observations could not be read, so a missing fold is never mistaken for an empty one. */
  readonly observationsUnavailableReason: string | null
}

/** Metadata for a freshly opened run. Written once as `run.json`. */
export interface RunMeta {
  /** Run identity, also the directory name. */
  readonly runId: string
  /** When the run started, epoch milliseconds. */
  readonly startedAt: number
  /** The stimulus every trial in this run shares, at the identity level. */
  readonly stimulus: StimulusRecord
  /** The task every trial in this run shares, in full: the schema is here, not per trial. */
  readonly task: TaskRecord & { readonly outputSchema: unknown }
  /** Operator's note; free text, not interpreted. */
  readonly note: string | null
}

/** A run's on-disk home. */
export interface RunHandle {
  /** Run identity. */
  readonly runId: string
  /** Directory holding the capture, the metadata and the records. */
  readonly directory: string
  /** Absolute path of the captured harness file. */
  readonly harnessPath: string
  /** Absolute path of the JSONL record file. */
  readonly recordPath: string
  /** Append one trial. Resolves after the line is flushed. */
  append(record: TrialRecord): Promise<void>
  /**
   * Record the capability surface the harness turned out to have.
   *
   * Written after mounting rather than in `openRun`, because it is *observed*, not declared: a field
   * that claimed to describe the mounted harness while holding an empty placeholder would be a
   * plausible empty result — the exact failure this repository exists to avoid.
   * @param surface - rows, visible tools and visible skills, as probed.
   * @returns resolves once `run.json` is rewritten.
   */
  annotate(surface: CapabilitySurface): Promise<void>
  /**
   * Remove the whole directory.
   *
   * Used when a run never got past its gates: a directory that exists but holds no trial is worse than
   * no directory, because it looks like a run that found nothing.
   * @returns resolves once the directory is gone.
   */
  discard(): Promise<void>
}

/**
 * Record schema version.
 *
 * Bumped when a field's *meaning* changes, not when one is added: a reader must be able to tell whether
 * two files are comparable. 1 was the enum-shaped harness with `harness`/`trace` on every line; 2 is the
 * captured-harness shape; **3 renamed `harness` to `stimulus.harness`, `assembly` to `modelInput`, and
 * `effective` to `surface`** — same data, one vocabulary, so a 2 and a 3 file are not interchangeable by
 * accident. **4 narrowed `surface.skills` from "skills registered for that scope" to "skills the
 * subject can load"**, so a 3 file's skill list can include names the subject had no way to reach.
 */
const RECORD_SCHEMA = 4

/** The note a reader finds first. Short on purpose: it answers "which field do I compare?" */
const README = `This directory is one benchmark run.

  run.json        run identity, the stimulus every trial shared, the task, and the
                  capability surface the harness actually mounted with.
  harness.*       a verbatim copy of the harness under test. Re-running this run is
                  passing this file as harness.file.
  trials.jsonl    one JSON line per trial: stimulus, outcome, and two folded views.

How to read it
  1. Compare runs by stimulus.fingerprint, never by file names. Two runs with the
     same fingerprint applied the same harness on the same route; two with different
     fingerprints did not, whatever their file names say.
  2. trace says what the subject DID.  modelInput says what it WAS GIVEN.
  3. Both are facts, not scores. This plugin computes no statistics: group and average
     them outside, with whatever method your study needs.

A harness file is copied verbatim into this directory, so never put credentials in one.
`

/** Name of the record file inside a run directory. Fixed, so tooling can find it. */
export const RECORD_FILE = 'trials.jsonl'

/**
 * Where one run's directory is.
 *
 * Exported because a background run has to name its directory **before** the directory exists: the tool
 * returns the handle while the run is still starting. One formula, so the promise and the `openRun` that
 * keeps it cannot disagree.
 * @param root - parent directory for run directories.
 * @param runId - run identity, also the directory name.
 * @returns absolute directory path.
 */
export function runDirectoryFor(root: string, runId: string): string {
  return join(root, runId)
}

/**
 * Create a run directory and capture the harness into it.
 *
 * `w` (write, truncate) is deliberately not used and every file is created with `wx`: a run id that
 * already exists must be a caller error, because silently appending to a previous run's file would mix
 * two experiments into one file that still looks well-formed.
 *
 * @param root - parent directory for run directories.
 * @param meta - run metadata; written once as `run.json`.
 * @param captured - the harness, captured once; its `text` is what lands on disk.
 * @returns the handle used to append trial records.
 */
export async function openRun(
  root: string,
  meta: RunMeta,
  captured: CapturedHarness,
): Promise<RunHandle> {
  const directory = runDirectoryFor(root, meta.runId)
  const harnessPath = join(directory, captured.fileName)
  const recordPath = join(directory, RECORD_FILE)
  const metaPath = join(directory, 'run.json')
  const existedBefore = await isDirectory(directory)
  await mkdir(directory, { recursive: true })

  try {
    // The capture goes down first: from here on, the directory is the record of what ran.
    await writeFile(harnessPath, captured.text, { flag: 'wx' })
    // `wx` fails when the file exists — the guard against collapsing two runs into one file.
    await writeFile(recordPath, '', { flag: 'wx' })
    await writeFile(
      metaPath,
      `${JSON.stringify({ ...meta, recordSchema: RECORD_SCHEMA }, null, 2)}\n`,
      {
        flag: 'wx',
      },
    )
    await writeFile(join(directory, 'README.txt'), README, { flag: 'wx' })
  } catch (error) {
    // Only remove what this call created; a pre-existing directory belongs to someone else.
    if (!existedBefore) await rm(directory, { recursive: true, force: true })
    throw error
  }

  return {
    runId: meta.runId,
    directory,
    harnessPath,
    recordPath,
    async append(record: TrialRecord): Promise<void> {
      await appendFile(recordPath, `${JSON.stringify(record)}\n`, 'utf8')
    },
    async annotate(surface: CapabilitySurface): Promise<void> {
      const written = { ...meta, surface, recordSchema: RECORD_SCHEMA }
      await writeFile(metaPath, `${JSON.stringify(written, null, 2)}\n`, 'utf8')
    },
    async discard(): Promise<void> {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Project the resolved harness into its record form.
 * @param harness - the resolved harness.
 * @param faults - the faults applied for the whole run.
 * @returns the identity-level stimulus.
 */
export function stimulusRecord(harness: ResolvedHarness, faults: readonly Fault[]): StimulusRecord {
  const captured = harness.captured
  return {
    fingerprint: harness.fingerprint,
    harness: {
      source: captured.source,
      originPath: captured.source === 'file' ? captured.originPath : null,
      fileName: captured.fileName,
      digest: captured.digest,
    },
    route:
      harness.route.provider === null || harness.route.model === null
        ? null
        : { provider: harness.route.provider, model: harness.route.model },
    maxDepth: harness.maxDepth,
    faults,
  }
}
