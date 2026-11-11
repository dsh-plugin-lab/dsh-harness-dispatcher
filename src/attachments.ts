/**
 * The task's attachments: files the caller names, turned into the blocks the subagent runtime accepts.
 *
 * Two kinds, and they are **not** two flavours of the same thing — the host does different work with
 * each, so a bench that treated them alike would mis-describe its own experiment:
 *
 * | kind | what reaches the model |
 * |---|---|
 * | `image` | the image itself, **only** when the route declares `image` input; otherwise a placeholder line |
 * | `file` | never the bytes: one handle line naming the file, its size, its digest and a read-only path |
 *
 * So an image tests "can this harness use what it sees", while a file tests "can it go and read". A
 * harness with no file tool scores zero on the second and that is a finding, not a defect.
 *
 * Declared structurally, like [jobs.ts](jobs.ts): the attachment store is a host service this plugin
 * uses when a caller passes attachments and never otherwise, so it must not become a peer dependency.
 *
 * The bytes are **saved once per run, before trial 1**, so every trial receives the same durable
 * reference — a per-trial save would let two trials of one run cite different objects.
 *
 * @module dsh-harness-dispatcher/attachments
 */

import { extname, basename } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** What an attachment is, to the model and to the record. */
export type AttachmentKind = 'image' | 'file'

/** One attachment as the caller names it. */
export interface AttachmentInput {
  /** Path, resolved by the host filesystem backend. */
  readonly path: string
}

/** What one attachment turned out to be. Identity only: a record is evidence, not a byte store. */
export interface TaskAttachment {
  readonly kind: AttachmentKind
  /** Display name, i.e. the file's own name with no directory part. */
  readonly name: string
  /** Exact byte length of what was stored. */
  readonly bytes: number
  /** Durable content-addressed id, so a reader can find the object again. */
  readonly id: string
  /** Media type; images only. */
  readonly mediaType?: string
}

/** The task as the run receives it: the text, the blocks, and what the record keeps. */
export interface ResolvedPrompt {
  readonly text: string
  readonly blocks: readonly ContentBlock[]
  readonly attachments: readonly TaskAttachment[]
}

/** One attachment after the kind is decided and before anything is stored. */
export interface AttachmentPlan {
  readonly path: string
  readonly name: string
  readonly kind: AttachmentKind
  /** The declared media type for an image; `null` for a file. */
  readonly mediaType: string | null
}

/**
 * Extensions that make an attachment an image, and the media type they declare.
 *
 * Extension, not content: the store verifies the bytes against this declaration and refuses a
 * mismatch, so the guess cannot survive being wrong. Content sniffing here would be a second opinion
 * that the store does not consult.
 */
const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Ceiling on one file attachment's bytes.
 *
 * The store itself has no limit for verbatim files, but `readBytes` requires one and buffering an
 * arbitrary file to hand it to a store that will then keep it is not something a bench should do
 * silently. A larger artifact belongs in the subject's working directory, where its harness can choose
 * to read it.
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024

/** One stored attachment, as the store reports it. Structural: no peer dependency on the store. */
export interface StoredAttachment {
  /** Opaque, content-addressed storage id. */
  readonly attachmentId: string
  readonly bytes: number
  readonly mediaType?: string
  readonly name?: string
}

/** The attachment store, narrowed to the two saves this module performs. */
export interface AttachmentStoreSeam {
  /** Deployment policy; the accepted image media types are read from here, never re-declared. */
  readonly imageLimits: {
    readonly mediaTypes: readonly string[]
    readonly maxImageBytes: number
    readonly maxMessageImageBytes: number
  }
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<StoredAttachment>
  saveFile(input: { readonly data: Uint8Array; readonly name?: string }): Promise<StoredAttachment>
}

/** Everything this module borrows from the host. */
export interface PromptSeam {
  /** The durable store, or `undefined` when this profile mounts none. */
  readonly attachments: AttachmentStoreSeam | undefined
  /** Read one caller-supplied path. Bound by the caller to the host filesystem backend. */
  read(path: string, maxBytes: number): Promise<Uint8Array>
}

/**
 * Decide what one path is, from its extension alone.
 * @param path - the path the caller named.
 * @returns the plan: kind, display name and declared media type.
 */
export function planAttachment(path: string): AttachmentPlan {
  const name = basename(path)
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()] ?? null
  return {
    path,
    name: name === '' ? path : name,
    kind: mediaType === null ? 'file' : 'image',
    mediaType,
  }
}

/**
 * Why an image cannot be delivered on this route, or `undefined` when it can.
 *
 * Pure, because the answer is a wording decision and the wording is the whole point: the host does not
 * fail here — it quietly replaces the image with a placeholder line, and a trial that ran without the
 * image it was given is a wasted run that looks like a normal one.
 * @param route - `provider/model`, or `null` when no route could be resolved.
 * @param declaresImageInput - whether that route's model declares `image` in its input modalities.
 * @returns one actionable sentence, or `undefined`.
 */
export function imageDeliveryProblem(
  route: string | null,
  declaresImageInput: boolean | undefined,
): string | undefined {
  if (route === null) {
    return (
      'an image attachment needs the subject’s model route to be resolvable, and it is not: the ' +
      'host exposes no llm service, or the calling agent has no provider/model. Pass `provider` and ' +
      '`model` explicitly, or drop the image.'
    )
  }
  if (declaresImageInput === true) return undefined
  return (
    `route ${route} does not declare image input, so the host would replace every image with a ` +
    'placeholder line and the trials would run without it. Use an image-capable route (pass ' +
    '`provider` and `model`), or drop the image.'
  )
}

/**
 * Turn the caller's files into the blocks of one task.
 *
 * Order is preserved and the text always comes first: the prompt is the instruction and the
 * attachments are what it is about. Appending rather than interleaving is a deliberate limit — the
 * task is the controlled variable, and one text field plus one ordered list is one way to say it.
 *
 * @param text - the task text.
 * @param inputs - the files, in the caller's order.
 * @param seam - the store and the file reader.
 * @returns the text, the blocks the child receives, and the identity the record keeps.
 * @throws {Error} when an attachment cannot be read or the deployment does not accept it.
 */
export async function resolvePrompt(
  text: string,
  inputs: readonly AttachmentInput[],
  seam: PromptSeam,
): Promise<ResolvedPrompt> {
  const blocks: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
  if (inputs.length === 0) return { text, blocks, attachments: [] }

  const store = seam.attachments
  if (store === undefined) {
    throw new Error(
      `this task carries ${String(inputs.length)} attachment(s), but no durable attachment store is ` +
        'mounted: load @deepseek-ai/dsh-attachment and @deepseek-ai/dsh-attachment-local, or drop ' +
        '`attachments`. Attachments are stored once and referenced by id, so there is no path that ' +
        'passes the bytes through without one.',
    )
  }

  const attachments: TaskAttachment[] = []
  for (const input of inputs) {
    const plan = planAttachment(input.path)
    const stored = await save(plan, store, seam)
    attachments.push({
      kind: plan.kind,
      name: plan.name,
      bytes: stored.bytes,
      id: stored.attachmentId,
      ...(plan.mediaType === null ? {} : { mediaType: plan.mediaType }),
    })
    // The runtime takes the host's own block shape; the seam is structural, so the reference crosses
    // here without a peer dependency on the attachment package's branded id.
    blocks.push(
      plan.kind === 'image'
        ? ({ type: 'image', attachment: stored } as unknown as ContentBlock)
        : ({ type: 'file', attachment: stored } as unknown as ContentBlock),
    )
  }
  return { text, blocks, attachments }
}

/** Read one file and commit it to the store, refusing an image the deployment does not accept. */
async function save(
  plan: AttachmentPlan,
  store: AttachmentStoreSeam,
  seam: PromptSeam,
): Promise<StoredAttachment> {
  let data: Uint8Array
  if (plan.kind === 'image') {
    if (plan.mediaType !== null && !store.imageLimits.mediaTypes.includes(plan.mediaType)) {
      throw new Error(
        `"${plan.path}" is ${plan.mediaType}, which this deployment does not accept; it takes ` +
          `${store.imageLimits.mediaTypes.join(', ')}. Convert the image, or pass it as a file ` +
          'attachment by renaming nothing — a file attachment carries no media type at all.',
      )
    }
    data = await seam.read(plan.path, imageCap(store))
    try {
      return await store.saveImage({
        data,
        mediaType: plan.mediaType ?? 'image/png',
        name: plan.name,
      })
    } catch (error) {
      // The store verified the bytes and refused them; say which file, because the store names only
      // the code and the reader is holding a directory of images.
      throw new Error(`cannot attach "${plan.path}": ${describe(error)}`, { cause: error })
    }
  }

  data = await seam.read(plan.path, MAX_FILE_BYTES)
  try {
    return await store.saveFile({ data, name: plan.name })
  } catch (error) {
    throw new Error(`cannot attach "${plan.path}": ${describe(error)}`, { cause: error })
  }
}

/** How many bytes one image read may pull: the smaller of the two deployment ceilings. */
function imageCap(store: AttachmentStoreSeam): number {
  return Math.min(store.imageLimits.maxImageBytes, store.imageLimits.maxMessageImageBytes)
}

/** The message of an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
