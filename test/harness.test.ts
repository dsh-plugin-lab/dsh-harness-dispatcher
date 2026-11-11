import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG } from '../src/catalog.ts'
import {
  HarnessSpecError,
  harnessLabel,
  harnessPathCandidates,
  harnessRows,
  mountPathFor,
  resolveHarness,
} from '../src/harness.ts'

/**
 * Capturing a harness is where two doors become one value.
 *
 * The property that matters: whatever door the harness came through, the text captured is the text
 * mounted and the text recorded. Everything downstream — the copy in the run directory, the digest in
 * every record, the rows registered — derives from that single string.
 */
let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-harness-capture-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function deps() {
  return {
    defaults: { tools: ['fs'], maxDepth: 1, harnessDir: root },
    vocabulary: CATALOG,
  }
}

describe('harness path resolution', () => {
  it('resolves a bare name in the harness directory, supplying the extension', () => {
    const candidates = harnessPathCandidates('minus-web', root)
    expect(candidates).toEqual([
      join(root, 'minus-web'),
      join(root, 'minus-web.yml'),
      join(root, 'minus-web.yaml'),
      join(root, 'minus-web.json'),
    ])
  })

  it('does not invent extensions for a name that already has one', () => {
    expect(harnessPathCandidates('a.yml', root)).toEqual([join(root, 'a.yml')])
  })

  it('takes an absolute path as given, with no directory fallback', () => {
    // One rule: an absolute path is literal. The earlier version also tried the process directory,
    // which meant a relative name could silently pick up an unrelated file.
    expect(harnessPathCandidates('/etc/x.yml', root)).toEqual(['/etc/x.yml'])
  })
})

describe('capturing the shortcut', () => {
  it('records the compiled rows as JSON so a replay parses back to the same rows', async () => {
    const resolved = await resolveHarness({ harness: { tools: ['fs'] } }, deps())
    const captured = resolved.captured
    expect(captured.source).toBe('shortcut')
    expect(captured.fileName).toBe('harness.json')
    if (captured.source !== 'shortcut') throw new Error('expected a shortcut capture')
    expect(JSON.parse(captured.text)).toEqual(captured.rows)
  })

  it('gives the same shortcut the same digest and a different one a different digest', async () => {
    const a = await resolveHarness({ harness: { tools: ['fs', 'pwsh'] } }, deps())
    const b = await resolveHarness({ harness: { tools: ['pwsh', 'fs'] } }, deps())
    const c = await resolveHarness({ harness: { tools: ['fs'] } }, deps())
    expect(a.captured.digest).toBe(b.captured.digest)
    expect(a.captured.digest).not.toBe(c.captured.digest)
  })

  it('keeps the route and the depth out of the harness digest', async () => {
    const plain = await resolveHarness({ harness: { tools: ['fs'] } }, deps())
    const routed = await resolveHarness(
      { harness: { tools: ['fs'] }, provider: 'p', model: 'm', maxDepth: 2 },
      deps(),
    )
    // Same harness, different request: the harness identity must not move.
    expect(routed.captured.digest).toBe(plain.captured.digest)
    // But the stimulus fingerprint must, because what the subject receives differs.
    expect(routed.fingerprint).not.toBe(plain.fingerprint)
  })

  it('rejects both forms and neither form', async () => {
    await expect(resolveHarness({ harness: {} }, deps())).rejects.toThrow(HarnessSpecError)
    await expect(
      resolveHarness({ harness: { file: 'x.yml', tools: ['fs'] } }, deps()),
    ).rejects.toThrow(/never both/)
  })

  it('rejects half a route and an unusable depth', async () => {
    await expect(
      resolveHarness({ harness: { tools: ['fs'] }, provider: 'p' }, deps()),
    ).rejects.toThrow(/together/)
    await expect(
      resolveHarness({ harness: { tools: ['fs'] }, maxDepth: 0 }, deps()),
    ).rejects.toThrow(/at least 1/)
  })
})

describe('capturing a file', () => {
  it('keeps the extension, so a replay is parsed by the same parser', async () => {
    await writeFile(join(root, 'minus-web.yml'), '- name: x\n', 'utf8')
    const resolved = await resolveHarness({ harness: { file: 'minus-web' } }, deps())
    expect(resolved.captured.source).toBe('file')
    expect(resolved.captured.fileName).toBe('harness.yml')
  })

  it('records the origin path as evidence, though it is never used for mounting', async () => {
    await writeFile(join(root, 'labelled.yaml'), '- name: x\n', 'utf8')
    const resolved = await resolveHarness({ harness: { file: 'labelled' } }, deps())
    if (resolved.captured.source !== 'file') throw new Error('expected a file capture')
    expect(resolved.captured.originPath).toBe(join(root, 'labelled.yaml'))
  })

  it('rejects an empty file rather than mounting nothing', async () => {
    await writeFile(join(root, 'empty.yml'), '   \n', 'utf8')
    await expect(resolveHarness({ harness: { file: 'empty' } }, deps())).rejects.toThrow(/is empty/)
  })

  it('lists what it tried, so a missing file is diagnosable', async () => {
    await expect(resolveHarness({ harness: { file: 'absent' } }, deps())).rejects.toThrow(/Tried:/)
  })

  it('does not interpret the file — the host parses it', async () => {
    // The point of the include row: this plugin never interprets the dialect, so any text is capturable
    // and the Loader is the only thing that can reject it.
    const nonsense = 'not a row list at all\n'
    await writeFile(join(root, 'odd.yml'), nonsense, 'utf8')
    const resolved = await resolveHarness({ harness: { file: 'odd' } }, deps())
    if (resolved.captured.source !== 'file') throw new Error('expected a file capture')
    expect(resolved.captured.text).toBe(nonsense)
  })
})

describe('mounting rows', () => {
  it('hands a file harness to the host as one include row, addressed by a file: URL', async () => {
    // Not a bare path: the host resolves `path` with `new URL(path, baseUrl)`, so on a drive letter
    // `C:/x.yml` parses as URL scheme `c:` and `fileURLToPath` throws ERR_INVALID_URL_SCHEME.
    // Measured on Windows against 0.2.2-rc.1 — an absolute path in `path` never mounts.
    await writeFile(join(root, 'minus-web.yml'), '- name: x\n', 'utf8')
    const resolved = await resolveHarness({ harness: { file: 'minus-web' } }, deps())
    const rows = harnessRows(resolved.captured, join(root, 'harness.yml'))
    expect(rows[0]?.name).toBe('cordis:include')
    const path = (rows[0]?.config as { path: string }).path
    expect(path.startsWith('file:///')).toBe(true)
    expect(path).toContain('harness.yml')
  })

  it('mounts the operator file, not the run-directory copy', async () => {
    // The copy is evidence. Mounting it would move the resolution base to the run directory, which is
    // outside every profile tree, so every `@deepseek-ai/…` row name would fail to import.
    await writeFile(join(root, 'minus-web.yml'), '- name: x\n', 'utf8')
    const resolved = await resolveHarness({ harness: { file: 'minus-web' } }, deps())
    expect(mountPathFor(resolved.captured, '/run/dir/harness.yml')).toBe(
      join(root, 'minus-web.yml'),
    )
  })

  it('mounts the compiled rows for a shortcut, ignoring the path', async () => {
    const resolved = await resolveHarness({ harness: { tools: ['fs'] } }, deps())
    const rows = harnessRows(resolved.captured, '/run/dir/harness.json')
    expect(rows[0]?.name).toMatch(/^@deepseek-ai\/dsh-tool-/)
  })

  it('labels a harness so the mounted preset is identifiable', async () => {
    const resolved = await resolveHarness({ harness: { tools: ['fs'] } }, deps())
    expect(harnessLabel(resolved.captured)).toContain('tools=fs')
  })
})
