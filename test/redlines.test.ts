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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CATALOG, DEFAULT_TOOLS, TOOL_CATALOG, TOOL_KEYS } from '../src/catalog.ts'
import { foldEvent, emptyFold, finishFold, summarize } from '../src/fold.ts'
import { normalizeFaults } from '../src/fault.ts'
import { harnessRows, harnessLabel, sealedRows } from '../src/harness.ts'
import { normalizeShortcut, shortcutRows } from '../src/shortcut.ts'
import { SKILL_NAME } from '../src/skill.ts'
import { presetIdFor } from '../src/subject.ts'

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

  it('removes a run directory that never reached its first trial', () => {
    // The alternative is a directory holding no trial, which is indistinguishable from a run whose
    // subject did nothing — a plausible empty result.
    expect(sources().get('src/tools/harness-run.ts')).toMatch(
      /if \(!started\)\s*await run\.discard\(\)/,
    )
  })

  it('keeps a partially recorded run and says so', () => {
    // A cancelled run has usually already written data. Deleting it would destroy the experiment;
    // failing silently would look like it was lost.
    const tool = sources().get('src/tools/harness-run.ts') ?? ''
    expect(tool).toMatch(/the directory is kept, it is data/)
  })

  it('unmounts the harness and disposes the activation in a finally block', () => {
    const tool = sources().get('src/tools/harness-run.ts') ?? ''
    const trial = sources().get('src/trial.ts') ?? ''
    expect(tool).toMatch(/\}\s*finally\s*\{/)
    expect(tool).toContain('subject.dispose()')
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
    const tool = sources().get('src/tools/harness-run.ts') ?? ''
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
    for (const file of ['src/tools/harness-run.ts', 'src/tools/harness-inspect.ts']) {
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
    const skill = sources().get('src/skill.ts') ?? ''
    // Each of these is a trap that costs a real experiment when missed.
    expect(skill).toMatch(/CATALOGUE KEYS/)
    expect(skill).toMatch(/MODEL-FACING TOOL NAMES/)
    expect(skill).toMatch(/fingerprint/)
  })

  it('keeps the skill body under the host prune threshold', () => {
    // Above 8192 characters the standard preset's tool-result pruner trims the skill body.
    const skill = sources().get('src/skill.ts') ?? ''
    const body = skill.slice(skill.indexOf('const CONTENT = `'), skill.indexOf('`\n\n/**'))
    expect(body.length).toBeLessThan(8192)
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
    for (const file of ['src/tools/harness-inspect.ts', 'src/tools/harness-run.ts']) {
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
  })
})
