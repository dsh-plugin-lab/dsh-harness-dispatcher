/**
 * Plugin configuration, resolved once at load.
 *
 * Kept out of [index.ts](index.ts) so the shape a profile writes and the shape the tools read are one
 * declaration, and so the dot-path defaults live in one place instead of being re-derived per tool.
 *
 * @module dsh-harness-dispatcher/config
 */

import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TOOLS } from './catalog.ts'

/** Plugin configuration as a profile writes it. */
export interface Config {
  /** Directory that receives one subdirectory per benchmark run. Empty means the default under home. */
  outputRoot: string
  /** Directory a bare harness file name resolves in, and where `harness_export` writes. */
  harnessDir: string
  /** Catalogue keys the shortcut offers when it names none. */
  defaultTools: string[]
  /** Delegation budget granted to a subject when a caller names none. */
  defaultMaxDepth: number
  /** Upper bound on trials per call, so one tool call cannot monopolise the host. */
  maxTrials: number
  /** Upper bound on one trial's wall time, in milliseconds. `0` disables the per-trial budget. */
  trialTimeoutMs: number
}

export const Config: z<Config> = z.object({
  outputRoot: z.string().default(''),
  harnessDir: z.string().default(''),
  defaultTools: z.array(z.string()).default([...DEFAULT_TOOLS]),
  defaultMaxDepth: z.natural().min(1).default(1),
  maxTrials: z.natural().min(1).max(50).default(10),
  trialTimeoutMs: z.natural().default(0),
})

/** Configuration with its empty-string placeholders resolved to absolute paths. */
export interface ResolvedConfig extends Config {
  readonly outputRoot: string
  readonly harnessDir: string
}

/**
 * Resolve the paths a profile leaves blank.
 * @param config - configuration as the host validated it.
 * @returns the same values with absolute directories.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const home = join(homedir(), '.dsh', 'harness-dispatcher')
  return {
    ...config,
    outputRoot: config.outputRoot.trim() === '' ? join(home, 'runs') : config.outputRoot,
    harnessDir: config.harnessDir.trim() === '' ? join(home, 'harness') : config.harnessDir,
  }
}
