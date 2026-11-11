import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_BYTES,
  imageDeliveryProblem,
  planAttachment,
  resolvePrompt,
} from '../src/attachments.ts'
import type { AttachmentStoreSeam, PromptSeam, StoredAttachment } from '../src/attachments.ts'

/**
 * The task's attachments: what kind each path is, and what the record ends up holding.
 *
 * The fake store is not a mock of a host service — it is the seam's own contract, which is why these
 * assertions can be about *behaviour*: which save method ran, what ceiling the read used, and whether
 * any bytes reached the record.
 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const CSV = new Uint8Array([0x61, 0x2c, 0x62])

/** A store that admits everything and reports what it was handed. */
function store(overrides: Partial<AttachmentStoreSeam> = {}): AttachmentStoreSeam & {
  readonly savedImages: { mediaType: string; name?: string }[]
  readonly savedFiles: { name?: string }[]
} {
  const savedImages: { mediaType: string; name?: string }[] = []
  const savedFiles: { name?: string }[] = []
  return {
    savedImages,
    savedFiles,
    imageLimits: {
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxImageBytes: 1000,
      maxMessageImageBytes: 400,
    },
    async saveImage(input): Promise<StoredAttachment> {
      savedImages.push({
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      return {
        attachmentId: 'sha256:img',
        bytes: input.data.byteLength,
        mediaType: input.mediaType,
      }
    },
    async saveFile(input): Promise<StoredAttachment> {
      savedFiles.push(input.name === undefined ? {} : { name: input.name })
      return { attachmentId: 'sha256:file', bytes: input.data.byteLength }
    },
    ...overrides,
  }
}

/** A seam that reads from a fixed table and remembers the ceiling it was given. */
function seam(
  files: Record<string, Uint8Array>,
  attachmentStore: AttachmentStoreSeam | undefined,
): PromptSeam & { readonly caps: number[] } {
  const caps: number[] = []
  return {
    caps,
    attachments: attachmentStore,
    async read(path, maxBytes): Promise<Uint8Array> {
      caps.push(maxBytes)
      const found = files[path]
      if (found === undefined) throw new Error(`no such file: ${path}`)
      return found
    },
  }
}

describe('what an attachment is', () => {
  it('is an image exactly when the extension declares an image media type', () => {
    expect(planAttachment('/tmp/shot.png')).toMatchObject({ kind: 'image', mediaType: 'image/png' })
    expect(planAttachment('/tmp/shot.JPEG')).toMatchObject({
      kind: 'image',
      mediaType: 'image/jpeg',
    })
    expect(planAttachment('/tmp/shot.webp')).toMatchObject({
      kind: 'image',
      mediaType: 'image/webp',
    })
    expect(planAttachment('/tmp/shot.gif')).toMatchObject({ kind: 'image', mediaType: 'image/gif' })
  })

  it('is a file for everything else, including a file that has no extension', () => {
    // A `.csv` is not a weaker image: it is a *different experiment*, and the record must say which.
    expect(planAttachment('/tmp/data.csv')).toMatchObject({ kind: 'file', mediaType: null })
    expect(planAttachment('/tmp/README')).toMatchObject({ kind: 'file', mediaType: null })
    expect(planAttachment('/tmp/archive.tar.gz')).toMatchObject({ kind: 'file', mediaType: null })
  })

  it('keeps the file’s own name and nothing of its directory', () => {
    expect(planAttachment('C:/work/secret/dir/shot.png').name).toBe('shot.png')
    expect(planAttachment('shot.png').name).toBe('shot.png')
  })
})

describe('delivering an image', () => {
  it('is refused when the route does not declare image input', () => {
    // The host does not fail here — it substitutes a placeholder line — so a silent downgrade would
    // produce a trial that never saw its input and a record that looks normal.
    const problem = imageDeliveryProblem('deepseek/chat', false)
    expect(problem).toContain('deepseek/chat')
    expect(problem).toContain('image-capable route')
  })

  it('is refused when the modalities are unknown, because unknown is not a promise', () => {
    expect(imageDeliveryProblem('deepseek/chat', undefined)).toContain('placeholder')
  })

  it('is refused when no route can be resolved at all, naming what to do', () => {
    const problem = imageDeliveryProblem(null, undefined)
    expect(problem).toContain('provider')
    expect(problem).toContain('model')
  })

  it('is allowed when the route declares image input', () => {
    expect(imageDeliveryProblem('deepseek/vision', true)).toBeUndefined()
  })
})

describe('building the task', () => {
  it('needs no store and no file when the task carries no attachment', async () => {
    const prompt = await resolvePrompt('do the thing', [], seam({}, undefined))
    expect(prompt.blocks).toEqual([{ type: 'text', text: 'do the thing' }])
    expect(prompt.attachments).toEqual([])
  })

  it('refuses attachments when the profile mounts no durable store', async () => {
    // Passing the bytes through without a store would be a second, undocumented path that skips the
    // admission the host performs — and it would make the recorded id meaningless.
    await expect(
      resolvePrompt('look', [{ path: '/tmp/shot.png' }], seam({ '/tmp/shot.png': PNG }, undefined)),
    ).rejects.toThrow(/dsh-attachment/)
  })

  it('sends the text first, then the attachments in the caller’s order', async () => {
    const prompt = await resolvePrompt(
      'describe',
      [{ path: '/tmp/a.png' }, { path: '/tmp/b.csv' }],
      seam({ '/tmp/a.png': PNG, '/tmp/b.csv': CSV }, store()),
    )
    expect(prompt.blocks.map((block) => block.type)).toEqual(['text', 'image', 'file'])
    expect(prompt.attachments.map((item) => item.kind)).toEqual(['image', 'file'])
    expect(prompt.attachments.map((item) => item.name)).toEqual(['a.png', 'b.csv'])
  })

  it('records identity only: no bytes, no data, exactly the five fields', async () => {
    // A record is evidence, not a byte store: an attachment copied in would make a run directory grow
    // with the size of its input, and two trials would then hold two copies of one object.
    const prompt = await resolvePrompt(
      'describe',
      [{ path: '/tmp/a.png' }, { path: '/tmp/b.csv' }],
      seam({ '/tmp/a.png': PNG, '/tmp/b.csv': CSV }, store()),
    )
    expect(Object.keys(prompt.attachments[0] ?? {}).sort()).toEqual([
      'bytes',
      'id',
      'kind',
      'mediaType',
      'name',
    ])
    expect(Object.keys(prompt.attachments[1] ?? {}).sort()).toEqual(['bytes', 'id', 'kind', 'name'])
    const serialized = JSON.stringify(prompt.attachments)
    expect(serialized).not.toContain('data')
    expect(serialized).not.toContain('[137')
    // And what is recorded is the durable id, so the object can be found again.
    expect(prompt.attachments.map((item) => item.id)).toEqual(['sha256:img', 'sha256:file'])
  })

  it('reads an image under the smaller of the two deployment ceilings', async () => {
    const reader = seam({ '/tmp/a.png': PNG }, store())
    await resolvePrompt('x', [{ path: '/tmp/a.png' }], reader)
    // A store that reports 1000 and a message budget of 400 must not be fed 1000 bytes.
    expect(reader.caps).toEqual([400])
  })

  it('reads a file under its own ceiling, not the image one', async () => {
    const reader = seam({ '/tmp/b.csv': CSV }, store())
    await resolvePrompt('x', [{ path: '/tmp/b.csv' }], reader)
    expect(reader.caps).toEqual([MAX_FILE_BYTES])
  })

  it('uses the deployment’s accepted set rather than its own copy of it', async () => {
    const pngOnly = store({
      imageLimits: {
        mediaTypes: ['image/png'],
        maxImageBytes: 1000,
        maxMessageImageBytes: 1000,
      },
    })
    await expect(
      resolvePrompt('x', [{ path: '/tmp/shot.jpg' }], seam({ '/tmp/shot.jpg': PNG }, pngOnly)),
    ).rejects.toThrow(/image\/png/)
    // The refusal has to name the file: the reader is holding a directory of images.
    await expect(
      resolvePrompt('x', [{ path: '/tmp/shot.jpg' }], seam({ '/tmp/shot.jpg': PNG }, pngOnly)),
    ).rejects.toThrow(/shot\.jpg/)
  })

  it('names the file when the store refuses its bytes', async () => {
    const refusing = store({
      async saveImage(): Promise<StoredAttachment> {
        throw new Error('INVALID_IMAGE: the bytes do not decode')
      },
    })
    await expect(
      resolvePrompt('x', [{ path: '/tmp/broken.png' }], seam({ '/tmp/broken.png': PNG }, refusing)),
    ).rejects.toThrow(/broken\.png.*INVALID_IMAGE/)
  })
})
