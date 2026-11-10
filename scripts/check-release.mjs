/**
 * Release-state check — the invariants a published artifact must have.
 *
 * Why it exists: these rules used to live only in `docs/PUBLISHING.md`, i.e. in prose that nobody
 * executes. A release flow runs this before publish, so "the manifest says so" is no longer a
 * sentence but a result.
 *
 * Two groups, and both of them guard **silent** failures:
 * - **Plugin display metadata**: the host reads `locale/*.json` and `package.json` out of the
 *   package directly — not one line of our code runs in that path. So whether the files exist,
 *   and whether `exports` and `files` actually carry them, can only be checked here. Any gap and
 *   the host **silently falls back** (title to the package name, description to
 *   `package.json.description`, icon to the default): the plugin page reports nothing.
 * - **Declaration self-consistency**: `engines.dsh` and every `@deepseek-ai/dsh-*` peer must not
 *   disagree about the floor. When they do, a user installing by the range we advertise cannot get
 *   a working host.
 *
 * Exit codes: 0 = all green / 1 = something failed / 2 = precondition missing (no readable manifest).
 *
 * **Per-repository additions belong here too** — a repository with extra invariants appends its own
 * assertions below the shared ones. What must not happen is a repository *dropping* one of these:
 * they are the cross-repository agreement, not a starting suggestion.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const failures = []
let pkg
try {
  pkg = JSON.parse(readFileSync('package.json', 'utf8'))
} catch (error) {
  console.error('cannot read package.json — the precondition for the release check is unmet.')
  console.error(String(error))
  process.exit(2)
}

/** Assert one release-state invariant. */
function require_(label, ok, hint) {
  if (!ok) failures.push(`${label} — ${hint}`)
}

// --- The manifest's own shape ------------------------------------------------------------

require_(
  'files is a non-empty array',
  Array.isArray(pkg.files) && pkg.files.length > 0,
  'an empty or missing "files" ships whatever npm defaults to, which is not this list.',
)
require_(
  'dsh.bundle.patch',
  pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'the bundle layer needs it; without it an installed package is not loaded into a profile.',
)
require_('private', pkg.private !== true, 'remove "private": true before releasing.')
require_(
  'engines.dsh',
  typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.trim() !== '',
  'the host compatibility range must be declared; it drifts, so only "declared and non-empty" is judged here.',
)
require_(
  'files includes cordis.patch.yml',
  Array.isArray(pkg.files) && published('cordis.patch.yml', pkg.files),
  'the bundle layer depends on it.',
)
require_(
  'LICENSE exists',
  existsSync('LICENSE'),
  'package.json declares MIT, so the repository must carry the file.',
)

/** npm's `files` semantics: a positive pattern covers, a negated one excludes. */
function published(file, files) {
  const covered = (pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    return (
      normalized === '.' ||
      normalized === '' ||
      matchesGlob(file, normalized) ||
      matchesGlob(file, `${normalized}/**`)
    )
  }
  return (
    files.some((pattern) => !pattern.startsWith('!') && covered(pattern)) &&
    !files.some((pattern) => pattern.startsWith('!') && covered(pattern.slice(1)))
  )
}

/** Only `*` (within a segment) and `**` (across segments) — enough to read `files`, no dependency. */
function matchesGlob(file, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${body}$`).test(file)
}

/** A non-empty string. */
function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Read a JSON file; a failure is recorded and reported as undefined. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`${file} — unreadable or not valid JSON: ${String(error)}`)
    return undefined
  }
}

// --- Display metadata --------------------------------------------------------------------

const LOCALE_DIR = 'locale'
const localeFiles = existsSync(LOCALE_DIR)
  ? readdirSync(LOCALE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
  : []

require_(
  `${LOCALE_DIR} exists`,
  localeFiles.length > 0,
  'the host reads the plugin title and description from here; missing it falls back silently.',
)
if (localeFiles.length > 0) {
  require_(
    'locale/en.json is the entry point',
    localeFiles.includes('en.json'),
    'the host parses that one first; without it the other language files are never read.',
  )
  require_(
    'exports exposes ./locale/*.json',
    pkg.exports?.['./locale/*.json'] === './locale/*.json',
    'the host resolves language files through Node; without this subpath export not one is readable.',
  )
}
require_(
  'exports exposes ./package.json',
  pkg.exports?.['./package.json'] === './package.json',
  'the title/description fallback and the icon declaration are both read from the exported manifest.',
)

for (const name of localeFiles) {
  const file = `${LOCALE_DIR}/${name}`
  const language = name.slice(0, -5)
  require_(
    `${file}: the file name is a language id`,
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
    'the host takes the file name for the language id; a malformed shape degrades the whole package to one diagnostic.',
  )
  require_(
    `files includes ${file}`,
    published(file, pkg.files),
    'a language file that is not in the installed package is only visible in local development — the plugin page falls back silently.',
  )
  const parsed = readJson(file)
  if (parsed === undefined) continue
  require_(
    `${file}: meta.title`,
    isText(parsed.meta?.title),
    'the title must be a non-empty string: a wrong field name or an empty string is the same as writing nothing.',
  )
  require_(`${file}: meta.description`, isText(parsed.meta?.description), 'same.')
}

// Two language files must have byte-identical key sets: a missing field only shows up in that language.
if (localeFiles.length > 1) {
  const shapes = localeFiles.map((name) => ({
    name,
    keys: Object.keys(readJson(`${LOCALE_DIR}/${name}`)?.meta ?? {})
      .sort()
      .join(','),
  }))
  const first = shapes[0]
  for (const shape of shapes.slice(1)) {
    require_(
      `${LOCALE_DIR}/${shape.name}: same key set as ${LOCALE_DIR}/${first.name}`,
      shape.keys === first.keys,
      "with different key sets, the language missing a field shows the other language's copy.",
    )
  }
}

// --- The icon -----------------------------------------------------------------------------

/** Stat a regular file; returns undefined when it cannot be read or is not a regular file. */
function fileOf(file) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? stat : undefined
  } catch {
    return undefined
  }
}

// Judged against the host's own `iconOf()`: a relative path, one of four extensions, staying inside
// the manifest directory, a regular file, within the size ceiling. Missing any of them means the
// plugin page falls back to the default artwork plus one diagnostic — and reports no error.
const ICON_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_ICON_BYTES = 256 * 1024
require_(
  'icon is declared',
  typeof pkg.icon === 'string' && pkg.icon !== '',
  'the plugin page falls back to the host default artwork when no icon is declared.',
)
if (typeof pkg.icon === 'string' && pkg.icon !== '') {
  const relative = pkg.icon.replace(/^\.\//, '')
  const inside =
    relative !== '' &&
    !relative.startsWith('/') &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(relative) &&
    !relative.split(/[\\/]/).includes('..')
  require_(
    'icon is a relative path inside the manifest directory',
    inside,
    'absolute paths, URLs and paths escaping the manifest directory are all rejected by the host.',
  )
  require_(
    'icon extension is one the host accepts',
    ICON_TYPES.includes(extname(relative).toLowerCase()),
    'the host only accepts SVG / PNG / JPEG / WebP.',
  )
  const iconFile = inside ? fileOf(relative) : undefined
  require_(
    'icon exists and is a regular file',
    iconFile !== undefined,
    'declared but unreadable: the plugin page shows only the default artwork, without an error.',
  )
  require_(
    'icon is within the size ceiling',
    (iconFile?.size ?? 0) <= MAX_ICON_BYTES,
    'the host rejects anything above 256 KiB.',
  )
  require_(
    'files includes the declared icon',
    inside && published(relative, pkg.files),
    'the icon must be self-contained and shipped, otherwise the plugin page shows only the default artwork.',
  )
}

// --- The release flow --------------------------------------------------------------------

/**
 * Commands inside the release flow that **rewrite the version**.
 *
 * Why this must exist: the version shown on screen is the one in `package.json`. A flow that bumps
 * it itself leaves the working tree permanently on "the last published version", so a screenshot
 * taken afterwards shows a stale number.
 *
 * The criterion only recognises **lines that would run**: YAML comments and `echo` do not count —
 * otherwise a correct "bump this locally first" reminder would fail its own guard.
 *
 * @param {string} source - the text of `release.yml`.
 * @returns {string[]} the offending command lines; empty means clean.
 */
export function findVersionWrites(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => !/^\s*echo\b/.test(line))
    .filter((line) =>
      /(?:npm|pnpm|yarn)\s+version\b|(?:npm|pnpm|yarn)\s+pkg\s+set\b|"version"\s*:/.test(line),
    )
    .map((line) => line.trim())
}

if (existsSync('.github/workflows/release.yml')) {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
  const writes = findVersionWrites(workflow)
  require_(
    'the release flow does not rewrite the version',
    writes.length === 0,
    `release.yml contains a command that changes the version: ${writes.join(' / ')}. The version is bumped and committed separately, before the release; otherwise the working tree stays on the last published version and the version shown on screen is stale.`,
  )
}

// --- Declaration self-consistency --------------------------------------------------------

// Compare **floors**, not shapes: the shape of a range is the maintainer's choice and may change.
// What these two assertions hold is declaration **self-consistency** — one fact is not written
// down as two different values. Compatibility itself is decided by `engines.dsh` alone: since
// 0.2.1-alpha.4 an own `engines.dsh` is read on its own and the `@deepseek-ai/dsh*` peer ranges are
// ignored (`packages/boot/app-boot/src/plugin-compatibility.ts`). Before that release the peer
// edges were the gate and a peer floor really could leave a host uninstallable — that is the rule
// this comparison was written for, and why the two are still held to agree; it survives as a
// consistency check, not as a compatibility claim.
const floor = typeof pkg.engines?.dsh === 'string' ? pkg.engines.dsh.trim() : ''
const floorVersion = lowerBoundOf(floor)
require_(
  'engines.dsh yields a readable floor',
  floorVersion !== undefined,
  `engines.dsh is ${JSON.stringify(floor)}; without a floor there is nothing to compare the peers against.`,
)
if (floorVersion !== undefined) {
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    const text = String(range).trim()
    const version = lowerBoundOf(text)
    require_(
      `peer ${name} yields a readable floor`,
      version !== undefined,
      `the peer range is ${text}; an unrecognised shape wants a human look rather than a silent skip.`,
    )
    require_(
      `peer ${name} floor is not below engines.dsh`,
      version !== undefined && compareFloor(version, floorVersion) >= 0,
      `the peer range is ${text} (floor ${version ?? '?'}) and engines.dsh is ${floor} — the same declaration written two ways; engines.dsh is the one that decides.`,
    )
  }
}

/** The lowest version in a dependency range; undefined when the shape is not recognised. */
function lowerBoundOf(range) {
  const parts = String(range).split('||')
  const bounds = []
  for (const part of parts) {
    // For a range like `>=a <b`, take the first comparison token only.
    const token = part.trim().split(/\s+/)[0] ?? ''
    const match = token.match(/^(?:>=|\^|~)?\s*v?(\d[\w.-]*)$/)
    if (match === null) return undefined
    bounds.push(match[1])
  }
  if (bounds.length === 0) return undefined
  return bounds.reduce((lowest, next) => (compareFloor(next, lowest) < 0 ? next : lowest))
}

/** Order two `x.y.z[-pre]` versions; floor comparison only, no semver dependency. */
function compareFloor(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = value.split('-', 2)
    const nums = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff
  }
  // The side carrying a prerelease segment is the lower one (`0.1.7-alpha.1` < `0.1.7`).
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

if (failures.length > 0) {
  console.error('release check failed:')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('release check passed')
