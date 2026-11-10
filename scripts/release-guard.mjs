#!/usr/bin/env node
/**
 * Release noise guard: does the change set since the last tag actually change the published artifact?
 *
 * The criterion is "can it change what is on npm", **not** "does the file ship". For example a build
 * script is not itself in the package, yet it decides what the build output looks like — so it counts.
 *
 * Usage (reads paths from stdin, one per line):
 *   git diff --name-only v0.1.0..HEAD | node scripts/release-guard.mjs
 *
 * Exit codes: 0 = the artifact changes, releasing is allowed / 1 = only non-artifact changes, this
 * release should not happen / 2 = usage error.
 *
 * **Exclusion, not inclusion**: an unrecognised path counts as a change to the artifact. Missing a
 * release (someone has to answer again) beats blocking a release that should have happened.
 *
 * What it can only judge is **paths**. A behaviour-preserving edit — a renamed constant, a moved
 * string — looks identical to a real change from here. That part is a human's answer; this script
 * cleanly rules out the one tier that is certainly not a release: docs, tests, CI, tooling.
 */

import { readFileSync } from 'node:fs'

const USAGE = `Usage:
  git diff --name-only <previous tag>..HEAD | node scripts/release-guard.mjs

Exit codes: 0 = the artifact changes / 1 = only non-artifact changes / 2 = usage error`

/**
 * Prefixes whose changes never reach the published artifact.
 *
 * `scripts/` is on this list, and that is only true because **the build is a config file at the
 * repository root** (dsh-plugin-sample's builder reads `tsdown.config.ts`, which is not under `scripts/`).
 * The day this repository adds a script that produces `lib/`, move that one file out of the
 * prefix and into `ARTIFACT_SCRIPTS` below — otherwise the change is silently taken for a
 * non-artifact one.
 */
const NON_ARTIFACT_PREFIXES = ['.agents/', '.github/', 'docs/', 'scripts/', 'test/']

/** Scripts that do produce `lib/`, so they are counted as artifacts despite the prefix above. */
const ARTIFACT_SCRIPTS = new Set([])

/** Root-level files that do not ship, or that only affect the toolchain. */
const NON_ARTIFACT_FILES = new Set([
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.pre-commit-config.yaml',
  '.prettierignore',
  '.prettierrc.json',
  'AGENTS.md',
  'eslint.config.mjs',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.client.json',
  'vitest.config.ts',
])

/** Does this path change the published artifact? */
function changesArtifacts(file) {
  if (ARTIFACT_SCRIPTS.has(file)) return true
  if (NON_ARTIFACT_FILES.has(file)) return false
  return !NON_ARTIFACT_PREFIXES.some((prefix) => file.startsWith(prefix))
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(2)
}
if (args.length > 0) {
  console.error(`unrecognised arguments: ${args.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.stdin.isTTY) {
  console.error('no change list received on stdin.')
  console.error(USAGE)
  process.exit(2)
}

const changed = readFileSync(0, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)

if (changed.length === 0) {
  console.log('no changes since the previous tag; nothing to release.')
  process.exit(1)
}

const artifacts = changed.filter(changesArtifacts)
const others = changed.filter((file) => !changesArtifacts(file))

if (artifacts.length > 0) console.log(`changes affecting the artifact: ${String(artifacts.length)}`)
for (const file of artifacts) console.log(`  - ${file}`)
if (others.length > 0) console.log(`changes that do not: ${String(others.length)}`)
for (const file of others) console.log(`  - ${file}`)

if (artifacts.length === 0) {
  console.log('\nonly non-artifact changes — this should not be released.')
  process.exit(1)
}
console.log('\nthe artifact changes; releasing is allowed.')
process.exit(0)
