/**
 * Plugin configuration, resolved once at load.
 *
 * Kept out of [index.ts](index.ts) so the shape a profile writes and the shape the tools read are one
 * declaration, and so the dot-path defaults live in one place instead of being re-derived per tool.
 *
 * @module dsh-harness-dispatcher/config
 */

import z from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
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
 *
 * `harnessDir` defaults to **inside the profile directory**, and that is not cosmetic. A harness file's
 * bare `@deepseek-ai/…` row names resolve through the host's interception layer only when the importing
 * file sits inside a profile tree or a linked package; measured on Windows against `0.2.2-rc.1`, a
 * harness file anywhere else imports and then fails every row with `MODULE_NOT_FOUND`. A default
 * outside the profile would therefore produce exports that cannot run — the worst kind of wrong default,
 * because it looks like it worked.
 *
 * @param config - configuration as the host validated it.
 * @param baseUrl - the plugin context's base URL, i.e. the profile's composition file.
 * @returns the same values with absolute directories.
 */
export function resolveConfig(config: Config, baseUrl?: string | undefined): ResolvedConfig {
  const home = join(homedir(), '.dsh', 'harness-dispatcher')
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
