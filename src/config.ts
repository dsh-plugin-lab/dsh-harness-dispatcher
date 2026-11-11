/**
 * Plugin configuration, resolved once at load.
 *
 * Kept out of [index.ts](index.ts) so the shape a profile writes and the shape the tools read are one
 * declaration, and so the dot-path defaults live in one place instead of being re-derived per tool.
 *
 * @module dsh-harness-dispatcher/config
 */

import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { fileURLToPath } from 'node:url'
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
 *
 * `harnessDir` defaults **inside the profile directory**, and that is not cosmetic: a harness file's
 * bare `@deepseek-ai/…` row names only resolve when the importing file sits inside a profile tree or a
 * linked package, so a default elsewhere would export files that cannot run — the worst kind of wrong
 * default, because it looks like it worked.
 *
 * Defaults go through `dshHomePath()` rather than `homedir()`: the host's home is `$DSH_HOME` when set,
 * so a hardcoded `~/.dsh` writes records into a different instance's tree.
 *
 * @param config - configuration as the host validated it.
 * @param baseUrl - the plugin context's base URL, i.e. the profile's composition file.
 * @returns the same values with absolute directories.
 */
export function resolveConfig(config: Config, baseUrl?: string | undefined): ResolvedConfig {
  const home = dshHomePath('harness-dispatcher')
  return {
    ...config,
    outputRoot: config.outputRoot.trim() === '' ? join(home, 'runs') : config.outputRoot,
    harnessDir:
      config.harnessDir.trim() === ''
        ? join(profileDirectoryOf(baseUrl) ?? home, 'harness')
        : config.harnessDir,
  }
}

/** The directory of the profile a context belongs to, or undefined when the base URL is not a file. */
function profileDirectoryOf(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  try {
    return fileURLToPath(new URL('.', baseUrl))
  } catch {
    return undefined
  }
}
