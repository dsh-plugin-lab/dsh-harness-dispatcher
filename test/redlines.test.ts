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

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CATALOG, DEFAULT_TOOLS, TOOL_CATALOG, TOOL_KEYS } from '../src/catalog.ts'
import { imageDeliveryProblem, resolvePrompt } from '../src/attachments.ts'
import { foldEvent, emptyFold, finishFold, summarize } from '../src/fold.ts'
import { normalizeFaults } from '../src/fault.ts'
import { harnessRows, harnessLabel, sealedRows } from '../src/harness.ts'
import { jobOutcomeOf } from '../src/jobs.ts'
import { normalizeShortcut, shortcutRows } from '../src/shortcut.ts'
import { SKILL_NAME, readSkill, registerSkill, splitFrontmatter } from '../src/skill.ts'
import { summaryLine } from '../src/run.ts'
import { presetIdFor, presetSummaries, rowWarnings } from '../src/subject.ts'
import { toolSpecOf } from '../src/tool.ts'
import { stoppedByBudget } from '../src/trial.ts'

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

const DEFAULTS = { tools: ['fs'] }

/**
 * The code that performs a run, wherever it currently lives.
 *
 * The run body moved from the tool to `run.ts` when the background job arrived, and every red line that
 * held a promise about *how a run behaves* broke at once — because it named a file instead of a
 * responsibility. These judgements are about the run, so they read the files the run is made of: the
 * execution body and the tool that starts it.
 */
function runSources(): string {
  return ['src/run.ts', 'src/tools/harness-run.ts']
    .map((file) => sources().get(file) ?? '')
    .join('\n')
}

/** A valid stub-tool config; each test perturbs one field. */
const SPEC = {
  name: 'search_docs',
  description: 'Search the documentation.',
  parameters: { query: { type: 'string' as const, required: true } },
  result: 'no results',
}

/** One trial outcome, as a run summary carries it. Each test perturbs the fields it is about. */
const OUTCOME = {
  index: 1,
  childId: 'child-1',
  stopReason: 'completed',
  wallMs: 1000,
  toolCalls: 1,
  toolErrors: 0,
  observationsAvailable: true,
  timedOut: false,
} as const

describe('B1 — the catalogue is the only place a row is named', () => {
  it('every default tool is a real catalogue key', () => {
    // This is the rule that a load-time check once violated: `'fs' in TOOL_KEYS` is always false on a
    // Set, so the plugin refused to activate while every test stayed green.
    for (const key of DEFAULT_TOOLS) expect(TOOL_KEYS.has(key), key).toBe(true)
  })

  it('answers `has` for every catalogue key and for no other string', () => {
    for (const key of Object.keys(TOOL_CATALOG)) expect(TOOL_KEYS.has(key)).toBe(true)
    expect(TOOL_KEYS.has('wite')).toBe(false)
    // Guards the exact bug: the `in` operator answers differently, so assert the trap stays shut.
    expect(Object.hasOwn(TOOL_KEYS, 'fs')).toBe(false)
  })

  it('rejects an unknown shortcut key instead of silently shrinking the subject', () => {
    expect(() => normalizeShortcut({ tools: ['fs', 'wite'] }, DEFAULTS, CATALOG)).toThrow(
      /unknown tool/,
    )
  })

  it('the source mounts tool rows only through the catalogue', () => {
    for (const [file, text] of sources()) {
      // A hard-coded provider module id outside catalog.ts would let a row bypass validation.
      if (file.endsWith('catalog.ts')) continue
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
      expect(normalizeFaults([{ tool: 'read', mode }])[0]?.mode).toBe(mode)
    }
    expect(() => normalizeFaults([{ tool: 'read', mode: 'error' as 'fail' }])).toThrow(
      /must be one of/,
    )
  })

  it('refuses contradictory faults on one tool rather than letting the last win', () => {
    expect(() =>
      normalizeFaults([
        { tool: 'read', mode: 'deny' },
        { tool: 'read', mode: 'fail' },
      ]),
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
      expect(
        banned.test(stripProse(text)),
        `${file} computes a statistic; that belongs outside this repository`,
      ).toBe(false)
    }
  })

  it('the record schema carries no aggregate field', () => {
    const code = stripProse(sources().get('src/record.ts') ?? '')
    for (const field of ['mean', 'average', 'rate', 'score', 'pValue']) {
      expect(code, `record.ts must not declare "${field}"`).not.toContain(`${field}:`)
    }
  })
})

/** Remove comments so prose that *states* a rule is not mistaken for code that breaks it. */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '')
}

/**
 * Remove comments *and* the contents of plain string literals.
 *
 * The rules about statistics and credentials are about what the code *does*, and this plugin also ships
 * prose: a record-directory README that says "group and average them outside" is stating the rule, not
 * breaking it. Stripping literals keeps those rules strict about code without banning a word from
 * documentation.
 */
function stripProse(text: string): string {
  return stripComments(text)
    .replaceAll(/'[^'\n]*'/g, "''")
    .replaceAll(/"[^"\n]*"/g, '""')
    .replaceAll(/`[^`]*`/g, '``')
}

describe('B4 — a record holds facts, and no secrets', () => {
  it('declares no credential, token or prompt-body field', () => {
    const code = stripProse(sources().get('src/record.ts') ?? '')
    expect(code).not.toBe('')
    for (const field of ['apiKey', 'api_key', 'token:', 'credential', 'secret', 'authorization']) {
      expect(code, `record.ts must not declare "${field}"`).not.toContain(field)
    }
  })

  it('digests the prompt instead of storing it', () => {
    // The model-input view must carry a length and a digest, not the text: a record is evidence, not a
    // transcript, and an unbounded field grows without limit across trials.
    const fold = sources().get('src/fold.ts') ?? ''
    expect(fold).toMatch(/digestText\(text\)/)
    expect(fold).toMatch(/chars:\s*text\.length/)
  })

  it('warns a reader that the captured harness is verbatim', () => {
    // The copy lands in the evidence directory, so the directory itself has to say so.
    const record = sources().get('src/record.ts') ?? ''
    expect(record).toMatch(/never put credentials/i)
  })

  it('truncates the subject output rather than storing a transcript', () => {
    expect(sources().get('src/text.ts')).toMatch(/MAX_OUTPUT\s*=\s*\d{3,}/)
  })
})

describe("B5 — the fault gate changes nobody else's behaviour", () => {
  it('an idle gate returns the downstream decision untouched', () => {
    const gate = sources().get('src/gate.ts') ?? ''
    const occurrences = gate.match(/return next\(\)/g) ?? []
    expect(
      occurrences.length,
      'each of the three stages must delegate when unarmed',
    ).toBeGreaterThanOrEqual(3)
  })

  it('arms by Session id, so overlapping trials cannot disarm each other', () => {
    const gate = sources().get('src/gate.ts') ?? ''
    expect(gate).toContain('Map<string, ArmedSubject>')
    expect(gate).toContain('this.armed.get(sessionId) === subject')
  })
})

describe('B6 — a run leaves nothing behind', () => {
  it('scopes the preset id to its owner', () => {
    expect(presetIdFor('run-a')).not.toBe(presetIdFor('run-b'))
    expect(presetIdFor('run-a')).toContain('run-a')
  })

  it('removes a run directory that recorded no trial', () => {
    // The alternative is a directory holding no trial, which is indistinguishable from a run whose
    // subject did nothing — a plausible empty result. The condition is "recorded nothing", NOT "reached
    // the loop": the two readings differ by exactly one trial, and the gap between them was a stop that
    // landed during the mount, which left an empty directory behind.
    expect(runSources()).toMatch(/if \(!recorded\)\s*await run\.discard\(\)/)
    expect(runSources()).toMatch(/release\(ctx, subject, presetId, run, outcomes\.length > 0\)/)
  })

  it('keeps a partially recorded run and says so', () => {
    // A cancelled run has usually already written data. Deleting it would destroy the experiment;
    // failing silently would look like it was lost.
    expect(runSources()).toMatch(/the directory is kept, it is data/)
  })

  it('unmounts the harness and disposes the activation in a finally block', () => {
    const trial = sources().get('src/trial.ts') ?? ''
    expect(runSources()).toMatch(/\}\s*finally\s*\{/)
    expect(runSources()).toContain('subject.dispose()')
    expect(trial).toMatch(/activation\.dispose\(\)/)
  })

  it('refuses to reuse an existing run directory', () => {
    expect(sources().get('src/record.ts')).toContain("flag: 'wx'")
  })
})

describe('B7 — a missing measurement is recorded as missing, not as zero', () => {
  it('leaves usage null when the adapter reported nothing', () => {
    const observations = summarize([
      {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] },
      } as unknown as SessionEvent,
    ])
    expect(observations.trace.usage).toBeNull()
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
    expect(summarize(events).trace.usage).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unreportedSettlements: 1,
    })
  })

  it('distinguishes a cleared prompt from a missing one', () => {
    // "No system prompt" and "the prompt arrived once" are different inputs; a fold that skipped the
    // empty event would silently report the earlier text.
    const observations = summarize([
      {
        type: 'system/message',
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, message: { role: 'system', content: [] } },
      } as unknown as SessionEvent,
    ])
    expect(observations.modelInput.systemPrompt).toBeNull()
    expect(observations.modelInput.systemPromptUpdates).toBe(1)
  })

  it('agrees between the live fold and the offline fold', () => {
    const events = [
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    const state = emptyFold()
    for (const event of events) foldEvent(state, event)
    expect(finishFold(state)).toEqual(summarize(events))
  })
})

describe('B8 — the harness is captured, and the capture is what mounts', () => {
  it('mounts the operator file, never the run-directory copy', () => {
    // Measured on Windows against 0.2.2-rc.1: a harness file outside a profile tree imports, then fails
    // every `@deepseek-ai/…` row with MODULE_NOT_FOUND, because `Include` sets the resolution base to the
    // file's own directory. The run directory is outside every profile tree, so mounting the copy would
    // silently break every file harness.
    const tool = runSources()
    expect(tool).toContain('mountPathFor(')
    // Precisely: the copy must not be the path handed to `harnessRows` directly.
    expect(tool).not.toMatch(/harnessRows\([^,]+,\s*run\.harnessPath\)/)
  })

  it('addresses the include by a file: URL, never a bare path', () => {
    // `new URL('C:/x.yml', baseUrl)` parses `C:` as a scheme, so `fileURLToPath` throws
    // ERR_INVALID_URL_SCHEME and the row never mounts. A bare path in `path` is the Windows bug.
    const harness = sources().get('src/harness.ts') ?? ''
    expect(harness).toContain('pathToFileURL(')
    expect(harness).toMatch(/config: \{ path: fileURLOf\(/)
  })

  it('keeps the default export directory inside the profile tree', () => {
    // A harness file must sit on a resolution base for its row names to resolve, so a default outside the
    // profile would produce exports that cannot run.
    const config = sources().get('src/config.ts') ?? ''
    expect(config).toContain('profileDirectoryOf(')
    expect(config).toContain('baseUrl')
  })

  it('writes the captured text, so the copy is byte-identical to what was read', () => {
    expect(sources().get('src/record.ts')).toMatch(/writeFile\(harnessPath,\s*captured\.text/)
  })

  it('hands a file harness to the host instead of parsing it', () => {
    // We must not own a second definition of "a harness": a file passing our parser but failing the
    // Loader (or the reverse) would be a disagreement nothing could resolve.
    const rows = harnessRows(
      {
        source: 'file',
        originPath: '/a/b.yml',
        fileName: 'harness.yml',
        text: '- name: x\n',
        digest: '00000000',
      },
      '/run/harness.yml',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('cordis:include')
    expect(String((rows[0]?.config as { path: string }).path)).toContain('file:///')
  })

  it('imports no YAML parser of its own', () => {
    // The corollary of the previous test: a parser here would be the second definition.
    for (const [file, text] of sources()) {
      expect(text, `${file} must not parse the Loader dialect itself`).not.toMatch(
        /from ['"](js-yaml|yaml)['"]/,
      )
    }
  })

  it('labels the mounted harness so a record can be traced back', () => {
    expect(
      harnessLabel({
        source: 'shortcut',
        fileName: 'harness.json',
        text: '',
        digest: '00000000',
        rows: [],
        spec: { tools: ['fs'], persona: null, personaVariant: 'none' },
      }),
    ).toContain('tools=fs')
  })
})

describe('B9 — local `check` is the same command as CI', () => {
  /**
   * The rule: if `pnpm run check` is green, CI must be green. It was violated once — `check` ran
   * typecheck / build / test, while CI also ran `lint` and `format:check`. Hand-edited source went in
   * unformatted, the local suite stayed green, and the push went red.
   */
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }

  it('runs every step the CI workflow runs', () => {
    const check = scripts.scripts.check ?? ''
    for (const step of ['typecheck', 'build', 'test', 'lint', 'format:check']) {
      expect(check, `check must run "${step}" — CI does`).toContain(`pnpm run ${step}`)
    }
    expect(check).toContain('pnpm run check:release')
  })

  it('keeps the CI workflow in step (no step added there and forgotten here)', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    const check = scripts.scripts.check ?? ''
    const steps = [...ci.matchAll(/^\s+- run: pnpm run ([a-z:-]+)$/gm)].map((match) => match[1])
    const missing = steps.filter(
      (step) =>
        step !== 'typecheck' &&
        step !== 'build' &&
        step !== 'test' &&
        step !== 'lint' &&
        step !== 'format:check' &&
        !check.includes(`pnpm run ${step}`),
    )
    expect(missing, 'CI runs a step that `check` does not').toEqual([])
  })
})

describe('B10 — the mount diagnostic is read back, once', () => {
  /**
   * The rule that motivated the rewrite. `agentPresets.register()` **resolves even when the mount
   * failed** — it keeps the diagnosis in its own record and warns. A bench that does not read it back
   * starts a child against a preset that does not exist, fails there, and leaves an empty
   * `trials.jsonl` behind: a plausible empty result, which is the worst outcome an experiment can have.
   */
  it('asks the registry whether the harness is usable', () => {
    const subject = sources().get('src/subject.ts') ?? ''
    expect(subject).toContain('.broken')
    expect(subject).toMatch(/presets\.resolve\(/)
  })

  it('routes every mount through the one audited path', () => {
    // Two mount sites would mean two chances to forget the read-back.
    for (const file of ['src/run.ts', 'src/tools/harness-inspect.ts']) {
      const text = sources().get(file) ?? ''
      expect(text, `${file} must mount through mountSubject`).toContain('mountSubject(')
      expect(text, `${file} must not register a preset directly`).not.toContain('presets.register(')
    }
  })

  it('rejects a harness that mounts but offers nothing', () => {
    // A harness with no callable tool is not a subject; running it would record a subject that could not
    // act, and the record would look like a behaviour rather than a configuration error.
    expect(sources().get('src/subject.ts')).toContain('makes no tool callable')
  })
})

describe('B11 — an inspection can reach a preset without exporting it', () => {
  it('reads a preset through a scope lease, not a private mount', () => {
    // The first question a newcomer has is "what does `standard` actually give the subject?". Requiring
    // an export first is friction with no purpose, so inspection accepts a preset id directly.
    const inspect = sources().get('src/tools/harness-inspect.ts') ?? ''
    expect(inspect).toContain('surfaceOf(')
    expect(inspect).toContain('preset')
  })

  it('validates the route without a model call', () => {
    // An inspection that says ok and a run that fails on trial 1 is a broken promise.
    const inspect = sources().get('src/tools/harness-inspect.ts') ?? ''
    expect(inspect).toContain('resolveModelInfo')
  })
})

describe('B12 — the tools teach their own use', () => {
  it('registers a skill, from code rather than a directory someone must configure', () => {
    // A filesystem skill is invisible in any preset whose skill provider does not point at it — a dead
    // pointer that fails silently. The registration is code so it does not depend on a profile edit.
    expect(sources().get('src/skill.ts')).toContain('skills.register(')
    expect(SKILL_NAME).toBe('dsh-harness-bench')
  })

  it('treats the skill registry as optional', () => {
    // A profile without skills must still get a working bench.
    const skill = sources().get('src/skill.ts') ?? ''
    expect(skill).toContain("ctx.get('skills')")
    expect(skill).toContain('return false')
  })

  it('documents the two namespaces and the field to compare', () => {
    // Each of these is a trap that costs a real experiment when missed. The body is a file now, so this
    // reads the artifact that ships rather than the module that registers it.
    const { body } = readSkill()
    expect(body).toMatch(/CATALOGUE KEYS/)
    expect(body).toMatch(/MODEL-FACING TOOL NAMES/)
    expect(body).toMatch(/fingerprint/)
  })
})

describe('B13 — the vocabulary is one word per thing', () => {
  it('says harness, shortcut, surface and modelInput — not the retired synonyms', () => {
    // A renamed concept that leaves a synonym behind is two names for one thing, which is how a record
    // and a reader come to disagree about what a field means.
    const retired = [
      ['quick', /\bquick\b/],
      ['composition (as a type)', /\bComposition\b/],
      ['effective', /\beffective\b/],
      ['assembly (as a field)', /\bassembly\b/],
      ['TrialFacts', /\bTrialFacts\b/],
    ] as const
    for (const [file, text] of sources()) {
      const code = stripComments(text)
      // `express`/`assemble` fragments would trip a naive word match; these are word boundaries.
      for (const [word, pattern] of retired) {
        expect(pattern.test(code), `${file} still says "${word}"`).toBe(false)
      }
    }
  })

  it('keeps the three tools on one prefix so a catalogue groups them', () => {
    for (const tool of ['harness_inspect', 'harness_export', 'harness_run']) {
      const found = [...sources().values()].some((text) => text.includes(`name: '${tool}'`))
      expect(found, `no tool is registered as ${tool}`).toBe(true)
    }
    // The old names must be gone, or a caller following stale docs gets an unknown-tool error.
    for (const [file, text] of sources()) {
      for (const stale of ['run_benchmark', 'harness_check', 'harness_dump']) {
        expect(text.includes(`name: '${stale}'`), `${file} still registers ${stale}`).toBe(false)
      }
    }
  })

  it('names the record fields after the two views', () => {
    const record = sources().get('src/record.ts') ?? ''
    expect(record).toContain('readonly trace:')
    expect(record).toContain('readonly modelInput:')
    expect(record).toContain('readonly stimulus:')
  })

  it('keeps quick rows and catalogue keys in one vocabulary', () => {
    const rows = shortcutRows(normalizeShortcut({ tools: ['fs'] }, DEFAULTS, CATALOG))
    expect(rows).toHaveLength(1)
    expect(TOOL_KEYS.has('fs')).toBe(true)
  })
})

describe('B15 — a sealed harness is the whole tool set, not a delta', () => {
  it('puts the mask row before the harness rows', () => {
    // `tools.restrict` masks the scope it is called from, and a scope's own registrations are exempt.
    // Mounting the mask first is what keeps the harness's tools visible; reversed, the subject would
    // see nothing at all — a silent empty bench instead of an error.
    for (const file of ['src/tools/harness-inspect.ts', 'src/run.ts']) {
      const code = sources().get(file) ?? ''
      const mask = code.indexOf('sealedRows(')
      const harness = code.indexOf('harnessRows(')
      expect(mask, `${file} never masks`).toBeGreaterThan(-1)
      expect(mask < harness, `${file} mounts the harness before masking it`).toBe(true)
    }
  })

  it('ships the masking plugin as an addressable entry', () => {
    // It has to be resolvable by name from inside a preset tree, so it cannot live only in index.ts.
    expect(sources().get('src/sealed.ts')).toContain("export const name = 'harness-sealed'")
    expect(sources().get('src/sealed.ts')).toContain('tools.restrict(')
    expect(sources().get('src/harness.ts')).toContain("'dsh-harness-dispatcher/sealed'")
  })

  it('masks only on request, so an unsealed run keeps the host it measured', () => {
    expect(sealedRows([])).toEqual([])
    const rows = sealedRows(['read', 'write'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('dsh-harness-dispatcher/sealed')
    expect(rows[0]?.config).toEqual({ deny: ['read', 'write'] })
  })
})

describe('B16 — every import is a declared dependency', () => {
  /**
   * The rule: a package the source imports must be in the manifest. It was violated: `src/trial.ts`
   * imported `@deepseek-ai/dsh-agent` while neither `peerDependencies` nor `devDependencies` listed it.
   * Local typecheck stayed green because pnpm happened to hoist it as a transitive dependency; CI
   * installed the manifest and failed with TS2307. Same family as B9 — "green here" is not "green there".
   */
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  /** Package specifiers the source imports, split by whether the import survives compilation. */
  function imports(): { all: Set<string>; value: Set<string> } {
    const all = new Set<string>()
    const value = new Set<string>()
    for (const [file, text] of sources()) {
      if (file.endsWith('.test.ts')) continue
      for (const match of text.matchAll(/import\s+(type\s+)?[^;]*?from '([^.'][^']*)'/g)) {
        const specifier = match[2] ?? ''
        // Only `@scope/name` survives: relative paths were excluded above, node builtins do not start
        // with `@`, and subpaths are declared by their package.
        const pkg =
          (specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0]) ?? ''
        if (pkg === '') continue
        all.add(pkg)
        if (match[1] === undefined) value.add(pkg)
      }
    }
    return { all, value }
  }

  it('declares every host package the source imports', () => {
    const declared = new Set([
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ])
    const missing = [...imports().all].filter(
      (pkg) => pkg.startsWith('@deepseek-ai/') && !declared.has(pkg),
    )
    expect(missing, `imported but not declared: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps peer and dev ranges identical, as the dependency rule says', () => {
    for (const [pkg, range] of Object.entries(manifest.peerDependencies ?? {})) {
      expect(manifest.devDependencies?.[pkg], `${pkg} drifts between peer and dev`).toBe(range)
    }
  })

  it('leaves every host package with a runtime import external to the bundle', () => {
    // A bundled copy would give this plugin its own instance of host helpers, and the identity checks
    // those helpers rely on would then disagree with the running host. Type-only imports are erased,
    // so they need no external — which is why the assertion reads value imports, not declarations.
    const tsdown = readFileSync(join(ROOT, 'tsdown.config.ts'), 'utf8')
    for (const pkg of imports().value) {
      // Node builtins (`node:fs`, `fs`) are the platform, not a package; the bundler handles them.
      if (pkg.startsWith('node:') || !pkg.includes('/')) continue
      expect(tsdown, `${pkg} has a runtime import and must stay external`).toContain(`'${pkg}'`)
    }
  })
})

describe('B14 — documentation points at files and tools that exist', () => {
  /** Every markdown file in the repository, as `relative path → text`. */
  function documents(): Map<string, string> {
    const files = new Map<string, string>()
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'lib') continue
          walk(full)
          continue
        }
        if (!entry.endsWith('.md')) continue
        files.set(full.slice(ROOT.length).replaceAll('\\', '/'), readFileSync(full, 'utf8'))
      }
    }
    walk(ROOT)
    return files
  }

  it('names no retired tool', () => {
    // A doc that tells a caller to run `harness_check` sends them to an unknown-tool error. Renaming a
    // tool and leaving the prose behind is the cheapest way to make documentation lie.
    for (const [file, text] of documents()) {
      for (const stale of ['run_benchmark', 'harness_check', 'harness_dump']) {
        expect(text.includes(stale), `${file} still names the retired tool ${stale}`).toBe(false)
      }
    }
  })

  it('names no deleted source file', () => {
    // `src/composition.ts` and `src/quick.ts` were renamed in the vocabulary pass; a link to them is a
    // dead link that the link check cannot see, because markdown anchors are checked, not targets.
    const removed = ['src/composition.ts', 'src/quick.ts', 'src/tools/harness-check.ts']
    for (const [file, text] of documents()) {
      for (const gone of removed) {
        expect(text.includes(gone), `${file} still points at the removed ${gone}`).toBe(false)
      }
    }
  })

  it('describes the record fields the code actually writes', () => {
    // The record-directory README and the docs must use the same field names a reader will see.
    const record = sources().get('src/record.ts') ?? ''
    expect(record).toContain('modelInput')
    expect(record).toContain('stimulus')
    for (const [file, text] of documents()) {
      if (!text.includes('trials.jsonl')) continue
      // Any doc describing a trial line must name the two views by their shipped names.
      expect(
        text.includes('`assembly`'),
        `${file} still calls the model-input view \`assembly\``,
      ).toBe(false)
    }
  })
})

describe('B17 — the surface reports what the subject can reach, not what the registry holds', () => {
  /**
   * The rule: `surface` means "what the subject can actually call". It was violated by counting skills
   * from the registry for the subject's scope — `list({ scope })` merges the global layer, so a *sealed*
   * harness with four tools and no `skill` tool was recorded as having six skills it could not name. A
   * probe that answers a different question than its name promises is worse than no probe: the
   * experimenter reads "6 skills" and concludes the harness was contaminated, or that it was not.
   */
  it('reports no loadable skill when the subject has no way to load one', () => {
    const subject = sources().get('src/subject.ts') ?? ''
    // The condition the host itself publishes the catalogue on.
    expect(subject).toContain('SKILL_TOOL')
    expect(subject).toMatch(/tools\.includes\(SKILL_TOOL\)/)
    // A skill the model may not invoke is not reachable either; the `skill` tool refuses it.
    expect(subject).toMatch(/invocation\.modelInvocable/)
  })

  it('keeps three outcomes distinguishable: no registry, nothing loadable, a list', () => {
    // `null` (this host has no skill service) and `[]` (a service, nothing reachable) are different
    // inputs, exactly as a missing measurement differs from a zero one.
    const subject = sources().get('src/subject.ts') ?? ''
    expect(subject).toContain('return null')
    expect(subject).toContain('return []')
    const inspect = sources().get('src/tools/harness-inspect.ts') ?? ''
    expect(inspect).toMatch(/no skill registry on this host/)
  })
})

describe('B18 — a registration the plugin makes is released when the plugin unloads', () => {
  /**
   * The rule: state this plugin registers belongs to its fiber. It was violated in the skill half —
   * `ctx.get('skills').register(...)` returns a disposer filed under the *registry's* context, and it was
   * discarded. A hot reload then hit "already registered", kept the previous body and logged a warning:
   * editing the skill looked like it had no effect, which a reader would blame on the edit.
   */
  it('wraps the skill registration in an effect of this plugin', () => {
    const skill = sources().get('src/skill.ts') ?? ''
    expect(skill).toMatch(/ctx\.effect\(\s*\n?\s*\(\)\s*=>/)
    expect(skill).toContain("'harness.skill'")
  })

  it('does not let a failing skill registration take the tools down with it', () => {
    // The skill explains the bench; the tools are the bench. A profile that refuses the skill must still
    // get working tools, which is why `skills` is not an injected dependency either.
    const skill = sources().get('src/skill.ts') ?? ''
    expect(skill).toMatch(/catch \(error\)/)
    expect(skill).toContain('return false')
  })
})

describe('B19 — `sealed` promises only what the host can actually do', () => {
  /**
   * The rule: a mask is only claimed where it was measured. Two attempts at shadowing an inherited skill
   * (a same-name non-invocable registration written from inside the preset tree, tried both automatically
   * and by hand) left the catalogue intact on `0.2.2-rc.1`: `ctx.skills.register()` files a registration
   * into the layer of the registry's own context, which is the host, so the entry lands in the same layer
   * as the thing it was meant to shadow and the first registration wins. Shipping the mechanism anyway
   * would have meant a `sealed: true` that silently did not seal — the failure this repository exists to
   * prevent.
   */
  it('does not register skills from the mask row', () => {
    // Comments are stripped: the module *explains* in prose why registering cannot work, and the rule is
    // about what the code does.
    const sealed = stripComments(sources().get('src/sealed.ts') ?? '')
    expect(sealed).not.toContain('denySkills')
    expect(sealed).not.toContain('skills')
    // The one thing it does, and can prove.
    expect(sealed).toContain('ctx.tools.restrict(')
  })

  it('records the limitation where a caller will read it', () => {
    // A limitation nobody can find is how the next person re-implements the mask that does not work, so
    // both the fact and its reason have to survive in the doc.
    const harness = sources().get('src/harness.ts') ?? ''
    expect(harness).toMatch(/skill/i)
    const doc = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8')
    expect(doc).toMatch(/没有遮罩 API/)
    expect(doc).toMatch(/先到者赢/)
    // The other route that looked promising: injecting the service to get a scope-bound registry.
    expect(doc).toMatch(/PENDING/)
  })
})

describe('B24 — a registered skill is loadable, not merely listed', () => {
  /**
   * The rule: the registration must satisfy the contract the *loading* path validates, not only the one
   * `register()` validates.
   *
   * Measured 2026-11-11 on host `0.2.2-rc.1`: `dsh-harness-bench` appeared in the catalogue and calling
   * the `skill` tool on it failed with `loaded skill "dsh-harness-bench" source must be a string`. The
   * registry validates twice — `register()` leniently, `get()` (the path the `skill` tool takes) against
   * the full definition, which requires `source` and `provider` to be strings. `register()` defaults
   * `provider` but not `source`, so a registration without one lists fine and cannot be loaded: the skill
   * is present and unreachable, and no test noticed because nothing tried to load it.
   */
  it('carries a loadable registration: a source string and the body verbatim', () => {
    const registered: Record<string, unknown>[] = []
    const registry = {
      register: (skill: Record<string, unknown>) => {
        registered.push(skill)
        return () => undefined
      },
    }
    const ctx = {
      get: (name: string) => (name === 'skills' ? registry : undefined),
      effect: (run: () => unknown) => run(),
      logger: { info: () => undefined, warn: () => undefined },
    }
    const body = '# not empty\n\nThe body a model reads.'
    const ok = registerSkill(ctx as never, { name: SKILL_NAME, description: 'd', body })

    expect(ok).toBe(true)
    expect(registered).toHaveLength(1)
    const entry = registered[0] ?? {}
    // The two fields the loading validator insists on. `provider` is defaulted by the registry; `source`
    // is not.
    expect(typeof entry.source).toBe('string')
    expect(entry.source).not.toBe('')
    expect(entry.content).toBe(body)
    expect(entry.name).toBe(SKILL_NAME)
  })
})

describe('B25 — a verdict names the thing it measured', () => {
  /**
   * The rule: a label must not claim more than the check behind it. Two measured violations, both found
   * by reading the tools' own output on a live host:
   *
   * 1. An exported `minimal` harness was reported `harness NOT runnable` because two of its rows were
   *    denied by the profile's policy — while the very same file, run as it was, completed with two
   *    callable tools. `ok` was `problems.length === 0`, which made an advisory row a verdict.
   * 2. `harness_export` printed `digest 245ec695` for the file it wrote and an inspection of that same
   *    file printed `36b1b6d7`: a hash of the bytes versus a fingerprint over bytes + route + depth.
   *    Two 8-hex values, one word.
   */
  it('classifies a dead row as a warning, and keeps blocking problems separate', () => {
    const surface = {
      rows: [
        {
          id: 'bench-harness:tool-fs',
          module: '@deepseek-ai/dsh-tool-fs',
          enabled: true,
          fiberState: null,
        },
        {
          id: 'bench-harness:terminal-bash',
          module: '@deepseek-ai/dsh-terminal-bash',
          enabled: false,
          fiberState: null,
        },
      ],
      tools: ['read'],
      skills: [],
    } as const
    const warnings = rowWarnings({ ...surface, rows: [...surface.rows] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('terminal-bash')
    // And nothing at all for a harness whose rows all contribute.
    expect(rowWarnings({ ...surface, rows: [surface.rows[0]], skills: [] })).toEqual([])
  })

  it('does not let a warning turn the verdict into "cannot run"', () => {
    const code = stripComments(sources().get('src/tools/harness-inspect.ts') ?? '')
    // The verdict counts blocking problems only, and the two lists are rendered apart.
    expect(code).toMatch(/ok: problems\.length === 0/)
    expect(code).toMatch(/warnings: \[\.\.\.facts\.warnings\]/)
    expect(code).toContain('`Problems:')
    expect(code).toContain('`Warnings:')
    // A row that mounted disabled lives in the warning list by construction.
    expect(code).toMatch(/warnings: rowWarnings\(/)
  })

  it('names the file digest and the fingerprint differently', () => {
    // Same word for two quantities is how a reader concludes the file changed between two runs.
    const exported = stripComments(sources().get('src/tools/harness-export.ts') ?? '')
    expect(exported).toContain('file digest')
    const inspected = stripComments(sources().get('src/tools/harness-inspect.ts') ?? '')
    expect(inspected).toContain('fingerprint ${value.target.fingerprint}')
  })
})

describe('B26 — a background run is the same run, only waited for differently', () => {
  /**
   * The rule: two waits, one experiment.
   *
   * `run_in_background` exists because the foreground call holds the caller's turn for as long as the
   * trials take, and the host's answer to that is a job (`pwsh` and `workflow` both do it this way). The
   * temptation is to write a second, cheaper execution path for it — which would give the same experiment
   * two record shapes and, eventually, two behaviours behind one name. So the tool may only *choose* who
   * waits; the run itself stays in one place.
   */
  it('has exactly one execution body, called by both waits', () => {
    const tool = stripComments(sources().get('src/tools/harness-run.ts') ?? '')
    // Both branches call the same function. Its body is not in this file at all.
    expect(tool.match(/runBench\(/g) ?? []).toHaveLength(2)
    expect(tool).not.toContain('runTrial(')
    expect(tool).not.toContain('mountSubject(')
    expect(tool).not.toContain('openRun(')
    // And the run body is where the record is written, so one code path means one record shape.
    const body = stripComments(sources().get('src/run.ts') ?? '')
    expect(body).toContain('openRun(')
    expect(body).toContain('runTrial(')
    expect(body).toContain('mountSubject(')
  })

  it('starts the work with the job’s own cancellation, not the spent call signal', () => {
    // The tool call has already returned by then, so its signal is spent: a run wired to it could not be
    // stopped by `job_kill`, and every kill would look like it worked while the subject kept running.
    // Only the background branch is held to this — the foreground call is *supposed* to use `exec.signal`.
    const tool = stripComments(sources().get('src/tools/harness-run.ts') ?? '')
    const background = tool.slice(tool.indexOf('function startBackground'))
    expect(background).toContain('new AbortController()')
    expect(background).toMatch(/runBench\([\s\S]{0,300}controller\.signal/)
    expect(background).not.toContain('exec.signal')
  })

  it('says a background run has recorded nothing yet, instead of a zero', () => {
    // `recorded: 0` at return time is a plausible measurement of "nothing happened"; the field is
    // omitted, and the notice carries the counts.
    const tool = sources().get('src/tools/harness-run.ts') ?? ''
    expect(tool).toMatch(/Present only when this call waited/)
    expect(tool).toMatch(/recordPath: \{ type: 'string' \}/)
  })

  it('streams per-trial progress on a channel the model can read', () => {
    // Measured: lines appended with `channel: 'log'` never reached `job_output` — the registry filters
    // that label out of the model's consuming read, so "progress is streamed" would have been false
    // while looking implemented.
    const tool = stripComments(sources().get('src/tools/harness-run.ts') ?? '')
    expect(tool).not.toMatch(/channel:\s*'log'/)
    expect(tool).toMatch(/job\.append\(/)
    expect(tool).toMatch(/job\.updateProgress\(/)
  })

  it('maps a stopped run to `killed` and a broken one to `failed`', () => {
    // A reader's next step differs: "somebody stopped it" is not "it broke".
    expect(jobOutcomeOf(false, undefined, 'ok').status).toBe('completed')
    // A killed job carries no detail: the registry merges the caller's kill reason, and repeating it
    // here printed the reason twice in one status line.
    expect(jobOutcomeOf(true, new Error('stopped by job_kill'), 'partial')).toEqual({
      status: 'killed',
      result: 'partial',
    })
    // `detail` is a status line, so a multi-line message is cut to its first line — measured: the whole
    // paragraph ended up inside `[status: killed, …]`.
    expect(
      jobOutcomeOf(false, new Error('mount failed\nline two\nline three'), 'none'),
    ).toMatchObject({ status: 'failed', detail: 'mount failed', result: 'none' })
    // A non-Error is preserved rather than stringified into "[object Object]".
    expect(jobOutcomeOf(false, 'boom', 'x').detail).toBe('boom')
  })

  it('refuses to run in the background where no controller serves the agent', () => {
    // Silence would be worse than an error: the caller would wait on a notice that can never arrive,
    // because without `tool-jobs` nothing routes a settlement.
    const tool = sources().get('src/tools/harness-run.ts') ?? ''
    expect(tool).toMatch(/ctx\.get\('jobs'\)/)
    expect(tool).toMatch(/dsh-jobs/)
  })
})

describe('B27 — an attachment never degrades silently', () => {
  /** Bytes stand in for any file; the store fake only measures their length. */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  /**
   * The rule: an attachment either reaches the subject as asked, or the run does not start.
   *
   * Three measured ways to lose it quietly, all of them the host's own behaviour rather than a bug in
   * it: `LlmRuntime` swaps every image for a placeholder line when the resolved model does not declare
   * `image` input; a file never travels as bytes, only as one handle line naming a read-only path; and
   * a profile with no attachment store simply has nowhere to put the bytes. Any of the three, handled
   * by falling back, produces a trial that never saw its input and a record that looks normal — the
   * worst outcome an experiment can have.
   */
  it('refuses an image the subject’s route cannot deliver', () => {
    // Behaviour, not source shape: the decision is a wording judgement, so it is a pure function.
    expect(imageDeliveryProblem('p/m', false)).toContain('image-capable route')
    expect(imageDeliveryProblem('p/m', undefined)).toContain('placeholder')
    expect(imageDeliveryProblem(null, undefined)).toContain('provider')
    expect(imageDeliveryProblem('p/m', true)).toBeUndefined()
    // And the tool asks that question about the SUBJECT's route: the bench's override first, then the
    // parent's recorded request, then the parent's options — the host's own resolution order.
    const tool = stripComments(sources().get('src/tools/harness-run.ts') ?? '')
    expect(tool).toMatch(/assertImagesDeliverable\(/)
    expect(tool).toMatch(/inputModalities\?\.includes\('image'\)/)
    expect(tool).toMatch(
      /harness\.route\.provider \?\? recorded\?\.provider \?\? parent\.options\.provider/,
    )
  })

  it('refuses attachments where the profile mounts no durable store', async () => {
    // There is no pass-through path: the id in the record would name nothing.
    await expect(
      resolvePrompt('x', [{ path: '/tmp/a.png' }], {
        attachments: undefined,
        read: async () => PNG,
      }),
    ).rejects.toThrow(/dsh-attachment/)
  })

  it('keeps attachment identity in the record and the bytes out of it', async () => {
    const prompt = await resolvePrompt('x', [{ path: '/tmp/a.png' }], {
      attachments: {
        imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 10, maxMessageImageBytes: 10 },
        saveImage: async (input) => ({
          attachmentId: 'sha256:abc',
          bytes: input.data.byteLength,
          mediaType: input.mediaType,
        }),
        saveFile: async (input) => ({ attachmentId: 'sha256:def', bytes: input.data.byteLength }),
      },
      read: async () => PNG,
    })
    expect(JSON.stringify(prompt.attachments)).not.toContain('data')
    // The run directory's reader is told both facts: attachments are identified, not copied, and a file
    // arrives as a path rather than as contents. Otherwise a reader assumes the bytes are in there.
    const record = sources().get('src/record.ts') ?? ''
    expect(record).toMatch(/identified, not copied/)
    expect(record).toMatch(/handle\s+line naming a read-only path/)
  })

  it('says which half of the delivery a file attachment lost', () => {
    // The parameter description is the only place a caller learns that a "file" is a pointer, and that
    // an image needs an image-capable model. Getting this wrong costs a whole run, in silence.
    const params = sources().get('src/tools/params.ts') ?? ''
    expect(params).toMatch(/image the subject SEES/)
    expect(params).toMatch(/everything else becomes a file the subject can only READ/)
    expect(params).toMatch(/never copied into the run directory/)
  })
})

describe('B21 — a caller who knows nothing can still find out what exists', () => {
  /**
   * The rule: the free discovery step has to be reachable from zero knowledge. `harness_inspect` and
   * `harness_export` both take a preset **id**, and nothing listed the ids — so a newcomer could not use
   * the bench at all, and the skill's example (`standard`) was a hard-coded guess that need not exist on
   * another profile (this machine's default is `cordis`).
   */
  it('lists presets when no target is named, instead of demanding one', () => {
    const inspect = sources().get('src/tools/harness-inspect.ts') ?? ''
    // The guard that used to reject "neither" now answers it.
    expect(inspect).toContain('presetList(')
    expect(inspect).toMatch(/args\.preset === undefined && args\.harness === undefined/)
  })

  it('names the default, so a caller can pick the one a bare session would use', () => {
    const summaries = presetSummaries([
      { id: 'zeta', isDefault: false, rows: [1, 2] },
      { id: 'alpha', isDefault: true, rows: [1] },
    ])
    expect(summaries.map((preset) => preset.id)).toEqual(['alpha', 'zeta'])
    expect(summaries[0]?.isDefault).toBe(true)
    expect(summaries[0]?.rows).toBe(1)
  })

  it('lists a broken preset with its reason rather than hiding it', () => {
    // Dropping it would send the caller to another id and leave them wondering why nothing matches; the
    // fact they need is "the one you wanted is there and unusable".
    const [broken] = presetSummaries([
      { id: 'half', isDefault: false, rows: [], broken: 'row 3 names no plugin\nsecond line' },
    ])
    expect(broken?.broken).toContain('row 3 names no plugin')
    const inspect = sources().get('src/tools/harness-inspect.ts') ?? ''
    expect(inspect).toMatch(/cannot mount/)
  })
})

describe('B22 — the skill is one page, and it says everything once', () => {
  /**
   * The rule: a skill is paid for on every load, so it stays short — but "short" must not be reached by
   * dropping a fact that costs an experiment when missed. This line holds both halves: the ceiling, and
   * a checklist of the facts, each of which was learned the hard way.
   *
   * The body is a file, so these assertions read the shipped artifact rather than a copy of it.
   */
  const body = readFileSync(join(ROOT, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8')

  it('stays under the host prune threshold with room to spare', () => {
    // Above 8192 the standard preset's tool-result pruner trims the body mid-sentence.
    expect(body.length).toBeLessThan(8192)
    // And not by being terse to the point of losing facts: every section below must be present.
    for (const heading of [
      '# Benchmarking a harness',
      '## The loop',
      '## Shaping the subject',
      '## What the records say',
      '## Do not',
    ]) {
      expect(body, `the skill lost "${heading}"`).toContain(heading)
    }
  })

  it('keeps every fact that costs an experiment when missed', () => {
    for (const fact of [
      /no arguments/, // discovery comes first: without an id nothing else works
      /CATALOGUE KEYS/,
      /MODEL-FACING TOOL NAMES/,
      /fingerprint/,
      /sealed: true/,
      /cannot mask/, // skills: the one thing sealing does not cover
      /dsh-harness-dispatcher\/tool/, // a tool can be defined or replaced in the file
      /byte-identical/, // the task is the controlled variable
      /credentials/,
      /replaces/, // persona is a swap, not an addition — length says nothing
      /maxDepth/, // delegation is gated by the row, not by the request-level max_depth
      /timeout_ms/, // a budget-stopped trial is an observation, not a harness failure
      /run_in_background/, // a long run is a job, not a held turn
      /attachments/, // a task can carry a picture or a file, and the two are different experiments
      /placeholder line/, // an image the route cannot deliver is refused, not silently swapped
      /stopped: true/, // your own stop ends the waiting, not somebody else's work
    ]) {
      expect(body, `the skill no longer states ${String(fact)}`).toMatch(fact)
    }
  })

  it('is a real skill file: frontmatter with a matching name and a routing description', () => {
    // Without frontmatter the file is a Markdown fragment. Registering it from code still works, so
    // nothing fails at runtime — but `dsh-skill-filesystem` drops such a file, which means the artifact
    // looks like a skill and is not one. `name` must also equal the directory, since that is what a
    // filesystem provider keys on.
    const frontmatter = splitFrontmatter(
      readFileSync(join(ROOT, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8'),
    )
    expect(frontmatter, 'the skill file lost its frontmatter block').toBeDefined()
    expect(frontmatter?.fields.get('name')).toBe(SKILL_NAME)
    const description = frontmatter?.fields.get('description') ?? ''
    expect(description.length).toBeGreaterThan(40)
    // A block scalar would register the literal ">-" as the only routing signal the model gets.
    expect(description.startsWith('>')).toBe(false)
    expect(description.startsWith('|')).toBe(false)
  })

  it('fails loudly on a missing file, a bare body, or an empty one', () => {
    // The host validates a registration for name/description/invocation and nothing else, so a degraded
    // skill surfaces only when a model loads it. Each branch is a way to ship one of those.
    expect(() => readSkill(join(ROOT, 'skills', SKILL_NAME, 'no-such-file.md'))).toThrow(
      /could not be read/,
    )
    const dir = join(ROOT, 'test', 'fixtures')
    mkdirSync(dir, { recursive: true })
    const cases: [string, string, RegExp][] = [
      ['bare-body.md', '# just markdown\n', /no YAML frontmatter/],
      [
        'wrong-name.md',
        '---\nname: other\ndescription: x\n---\n\nbody\n',
        /must be the kebab-case/,
      ],
      [
        'block-scalar.md',
        '---\nname: dsh-harness-bench\ndescription: >-\n---\n\nbody\n',
        /single-line/,
      ],
      ['no-body.md', '---\nname: dsh-harness-bench\ndescription: x\n---\n\n', /no body/],
    ]
    try {
      for (const [file, text, expected] of cases) {
        const path = join(dir, file)
        writeFileSync(path, text, 'utf8')
        expect(() => readSkill(path), file).toThrow(expected)
      }
      // The real file passes every one of those checks.
      expect(readSkill().name).toBe(SKILL_NAME)
    } finally {
      for (const [file] of cases) rmSync(join(dir, file), { force: true })
    }
  })

  it('ships the body, so an installed package can still read it', () => {
    // Asserted independently of check-release because it is the failure mode with no runtime signal:
    // the plugin loads, the skill just is not there.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(manifest.files ?? []).toContain('skills')
  })
})

describe('B20 — a tool a harness defines is a tool, with a tool’s obligations', () => {
  /**
   * The rule: the row that stands up a tool must refuse the configs that produce a tool which exists but
   * cannot be used. All three cases below are silent on the host side — `run_code` throws only when the
   * registration reaches it, a malformed name registers and is never callable, an empty description is a
   * tool the model cannot route to. A bench that measures the wrong tool set because of a typo is the
   * "plausible empty result" this repository exists to avoid.
   */
  it('rejects the host’s reserved name and malformed names', () => {
    expect(() => toolSpecOf({ ...SPEC, name: 'run_code' })).toThrow(/reserved/i)
    for (const bad of ['has space', '1leading', '', 'a.b']) {
      expect(() => toolSpecOf({ ...SPEC, name: bad })).toThrow(/not usable/)
    }
    for (const good of ['search_docs', 'fetch-page', 'read']) {
      expect(toolSpecOf({ ...SPEC, name: good }).name).toBe(good)
    }
  })

  it('rejects an empty description or result instead of standing up a mute tool', () => {
    // The description is the only routing signal the model sees before calling, so an empty one is a
    // tool that is present in the catalogue and unreachable in practice.
    expect(() => toolSpecOf({ ...SPEC, description: '   ' })).toThrow(/description/)
    expect(() => toolSpecOf({ ...SPEC, result: '' })).toThrow(/result/)
  })

  it('defaults to no arguments, and refuses a non-object parameter spec', () => {
    const { parameters: _omitted, ...withoutParameters } = SPEC
    expect(toolSpecOf(withoutParameters).parameters).toEqual({})
    // `null` reads as "omitted", the same way an absent field does.
    expect(toolSpecOf({ ...SPEC, parameters: null }).parameters).toEqual({})
    for (const bad of [[], 'query', 7]) {
      expect(() => toolSpecOf({ ...SPEC, parameters: bad })).toThrow(/parameters/)
    }
  })

  it('leaves failure and latency to `faults`', () => {
    // Two mechanisms for one thing is how a bench starts measuring its own patches. The row returns one
    // literal string; `fail` and `latency` stay on the tool pipelines where they already apply to every
    // visible tool, including this one.
    const code = stripComments(sources().get('src/tool.ts') ?? '')
    expect(code).not.toMatch(/\bdelay|\blatency|throw new\b(?![^\n]*ToolSpecError)/i)
    expect(code).toContain('defineTool(')
  })
})

describe('B23 — a trial stopped by its own budget is stopped, not just labelled', () => {
  /**
   * The rule: `timedOut` must describe something that happened.
   *
   * Measured 2026-11-11 against host `0.2.2-rc.1`, `timeout_ms: 700` on a task that runs long: the
   * record said `timedOut: true` beside `stopReason: "completed"` and `wallMs: 15504`, because
   * `startActivation({ signal })` covers admission only — once the activation is accepted the child is
   * not wired to that signal at all. The trial ran to the end while claiming to have been cut short,
   * and `timedOut` is exactly the field a reader filters on to exclude interrupted trials.
   *
   * So two things must hold: the child is cancelled through the one API that stops a running child,
   * and `timedOut` is derived from what the result says rather than from the timer alone.
   */
  it('cancels the running child when the trial signal aborts', () => {
    const code = stripComments(sources().get('src/trial.ts') ?? '')
    // A listener on the fused signal is the only place the budget can reach the child.
    expect(code).toMatch(/onceAborted\(trialSignal,/)
    expect(code).toMatch(/activation\.dispose\(\)/)
    // The listener must not outlive the trial: one budget per trial, one listener per budget.
    expect(code).toMatch(/detachStop\(\)/)
  })

  it('reports `timedOut` only for a trial the budget actually ended', () => {
    // Behavioural: every combination the measured failure and its neighbours produce. `budget.aborted`
    // alone was true in the failure, which is exactly why the stop reason has to be consulted.
    const live = new AbortController()
    const fired = new AbortController()
    fired.abort()
    const callerStopped = new AbortController()
    callerStopped.abort()

    expect(stoppedByBudget(fired.signal, live.signal, 'aborted')).toBe(true)
    // The measured defect: the child finished before the cancellation landed.
    expect(stoppedByBudget(fired.signal, live.signal, 'completed')).toBe(false)
    // No budget at all, and a caller cancellation is not a timeout.
    expect(stoppedByBudget(undefined, live.signal, 'aborted')).toBe(false)
    expect(stoppedByBudget(fired.signal, callerStopped.signal, 'aborted')).toBe(false)
    // The budget has not fired yet.
    expect(stoppedByBudget(live.signal, live.signal, 'aborted')).toBe(false)
  })

  it('counts recorded trials and completed trials separately in what it returns', () => {
    // The measured run printed "0/1 trials recorded" while one line was on disk: the numerator was
    // `completed`, so a stopped trial read as a lost one.
    const summary = {
      runId: 'run-x',
      fingerprint: 'abc',
      directory: '/tmp/run-x',
      recordPath: '/tmp/run-x/trials.jsonl',
      harnessPath: '/tmp/run-x/harness.json',
      trials: 2,
      outcomes: [
        { ...OUTCOME, index: 1, stopReason: 'aborted', timedOut: true },
        { ...OUTCOME, index: 2, stopReason: 'aborted', timedOut: true },
      ],
      stopped: false,
    }
    expect(summaryLine(summary)).toBe(
      '2/2 trial(s) recorded, 0 completed → /tmp/run-x/trials.jsonl',
    )
  })
})

describe('B28 — a stop ends the waiting, not somebody else’s work', () => {
  /**
   * The rule: a subject is independent work, and who may stop it is a decision, not a side effect.
   *
   * A child gets its own Session and its own turn, so nothing propagates into it by itself. The two
   * callers want opposite things and both are right: interrupting the calling turn means "I will not
   * read any more of this", while `job_kill` means "stop that run". Wiring both to `dispose()` made the
   * first one kill work its owner never asked to kill, and the second interpretation is the reason the
   * field exists at either call site rather than being implied by which signal was passed.
   *
   * The other half of the same rule is what a stop must NOT do: it must not throw away a directory that
   * holds records, and it must not leave one that holds none.
   */
  it('stops starting trials instead of throwing away the one in flight', () => {
    const body = stripComments(sources().get('src/run.ts') ?? '')
    // The loop breaks; it does not `throwIfAborted()`, which would abandon a trial mid-thought.
    expect(body).toMatch(/if \(stop\.signal\.aborted\) \{/)
    expect(body).not.toContain('throwIfAborted')
    // And the outcome is reported rather than inferred from a short count.
    expect(body).toMatch(/stopped = true/)
    expect(body).toMatch(/outcomes,\s*\n\s*stopped,/)
  })

  it('says which caller may cancel the subject, at both call sites', () => {
    const tool = stripComments(sources().get('src/tools/harness-run.ts') ?? '')
    // Foreground: the calling turn's stop leaves the subject alone.
    expect(tool).toMatch(/signal: exec\.signal,\s*\n\s*stopSubject: false,/)
    // Background: killing the job is an instruction about this run.
    const background = tool.slice(tool.indexOf('function startBackground'))
    expect(background).toMatch(/signal: controller\.signal, stopSubject: true/)
  })

  it('only cancels the subject when the stop is allowed to', () => {
    const code = stripComments(sources().get('src/trial.ts') ?? '')
    // A stop that cannot cancel contributes nothing to the fused signal, so the budget is the only
    // thing that can end the trial early — which is exactly what `timedOut` is then told.
    expect(code).toMatch(/stop\.stopSubject\s*\n?\s*\?/)
    expect(code).toMatch(/stop\.stopSubject \? stop\.signal : undefined/)
  })

  it('does not blame the budget for a stop that happened before it fired', () => {
    const live = new AbortController()
    const fired = new AbortController()
    fired.abort()
    // A caller that cannot cancel is the same as nobody stopping: the budget is what ended the trial.
    expect(stoppedByBudget(fired.signal, undefined, 'aborted')).toBe(true)
    expect(stoppedByBudget(fired.signal, undefined, 'completed')).toBe(false)
    expect(stoppedByBudget(undefined, undefined, 'aborted')).toBe(false)
    expect(stoppedByBudget(live.signal, undefined, 'aborted')).toBe(false)
  })

  it('settles a killed job as killed, even though a stop is not an error', () => {
    // A stopped run returns a summary rather than throwing, so `error === undefined` used to mean
    // `completed`: a killed job read as a finished one that ran fewer trials than it asked for.
    expect(jobOutcomeOf(true, undefined, 'partial').status).toBe('killed')
    expect(jobOutcomeOf(false, undefined, 'done').status).toBe('completed')
  })

  it('tells a reader the run stopped, instead of leaving them to infer it', () => {
    const summary = {
      runId: 'run-y',
      fingerprint: 'abc',
      directory: '/tmp/run-y',
      recordPath: '/tmp/run-y/trials.jsonl',
      harnessPath: '/tmp/run-y/harness.json',
      trials: 4,
      outcomes: [{ ...OUTCOME, index: 1 }],
      stopped: true,
    }
    const line = summaryLine(summary)
    expect(line).toContain('1/4 trial(s) recorded')
    expect(line).toContain('stopped before every trial ran')
    // The same run without the stop is a different sentence, so the news cannot be read as boilerplate.
    expect(summaryLine({ ...summary, stopped: false })).not.toContain('stopped')
  })
})
