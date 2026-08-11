import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { UnsupportedFunctionalityError } from "@ai-sdk/provider"

export const MAX_CURSOR_IMAGE_INPUT_BYTES = 20 * 1024 * 1024

export type CursorImageInput = {
  data: Uint8Array
  filename: string
  mimeType: string
}

export type CursorHistoryImageExtraction = {
  images: CursorImageInput[]
  hashes: string[]
  candidateCount: number
  duplicateCount: number
}

export type CursorPromptImageExtraction = CursorHistoryImageExtraction & {
  userImageCount: number
}

export function hasCursorUserImages(lastUser: Record<string, unknown> | undefined): boolean {
  return !!lastUser && Array.isArray(lastUser.content) && lastUser.content.some((part) => {
    if (!part || typeof part !== "object") return false
    const file = part as Record<string, unknown>
    return file.type === "file" && typeof file.mediaType === "string" && file.mediaType.startsWith("image/")
  })
}

function unsupported(functionality: string, message: string): never {
  throw new UnsupportedFunctionalityError({ functionality, message })
}

export function assertCursorUserImageSupport(
  lastUser: Record<string, unknown> | undefined,
  supportsImages: boolean,
  modelId: string,
): void {
  if (!hasCursorUserImages(lastUser) || supportsImages) return
  unsupported(
    "image input",
    `Cursor model ${JSON.stringify(modelId)} does not support image input`,
  )
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, "")
  if (!normalized || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized)) {
    return unsupported("image input", "Cursor provider received invalid base64 image data")
  }
  const data = Uint8Array.from(Buffer.from(normalized, "base64"))
  if (data.length === 0) {
    return unsupported("image input", "Cursor provider received an empty image")
  }
  return data
}

function decodeDataUrl(value: string): { data: Uint8Array; mimeType?: string } {
  if (!value.startsWith("data:")) {
    return unsupported(
      "image input",
      "Cursor provider supports base64-encoded image data URLs only",
    )
  }
  const commaIndex = value.indexOf(",", 5)
  if (commaIndex < 0) {
    return unsupported(
      "image input",
      "Cursor provider supports base64-encoded image data URLs only",
    )
  }
  const metadata = value.slice(5, commaIndex)
  const finalSeparator = metadata.lastIndexOf(";")
  if (finalSeparator < 0 || metadata.slice(finalSeparator + 1) !== "base64") {
    return unsupported(
      "image input",
      "Cursor provider supports base64-encoded image data URLs only",
    )
  }
  const firstSeparator = metadata.indexOf(";")
  const mimeType = metadata.slice(0, firstSeparator)
  return {
    data: decodeBase64(value.slice(commaIndex + 1)),
    mimeType: mimeType || undefined,
  }
}

function inferImageMimeType(data: Uint8Array): string | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return "image/png"
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg"
  }
  if (data.length >= 6) {
    const header = Buffer.from(data.subarray(0, 6)).toString("ascii")
    if (header === "GIF87a" || header === "GIF89a") return "image/gif"
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp"
  return undefined
}

function assertImageSize(size: number, remaining: number): void {
  if (size > remaining) {
    unsupported(
      "image input",
      `Cursor provider image attachments exceed the ${MAX_CURSOR_IMAGE_INPUT_BYTES / 1024 / 1024} MiB limit`,
    )
  }
}

function cursorImageBudget(value: number): number {
  if (!Number.isFinite(value)) return MAX_CURSOR_IMAGE_INPUT_BYTES
  return Math.min(MAX_CURSOR_IMAGE_INPUT_BYTES, Math.max(0, Math.floor(value)))
}

function imageContentHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

async function readResponseBytes(response: Response, remaining: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > remaining) {
    assertImageSize(declaredLength, remaining)
  }
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer())
    assertImageSize(data.length, remaining)
    return data
  }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > remaining) {
        await reader.cancel()
        assertImageSize(total, remaining)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

async function resolveImageData(
  value: Uint8Array | string | URL,
  remaining: number,
  signal?: AbortSignal,
): Promise<{ data: Uint8Array; mimeType?: string; filename?: string }> {
  if (value instanceof Uint8Array) return { data: Uint8Array.from(value) }
  if (typeof value === "string") {
    return value.startsWith("data:") ? decodeDataUrl(value) : { data: decodeBase64(value) }
  }
  if (value.protocol === "data:") return decodeDataUrl(value.href)
  if (value.protocol === "file:") {
    const filePath = fileURLToPath(value)
    const info = await stat(filePath)
    assertImageSize(info.size, remaining)
    return { data: Uint8Array.from(await readFile(filePath)), filename: path.basename(filePath) }
  }
  if (value.protocol !== "http:" && value.protocol !== "https:") {
    return unsupported(
      "image URL input",
      `Cursor provider does not support image URL protocol ${JSON.stringify(value.protocol)}`,
    )
  }

  const response = await fetch(value, { signal })
  if (!response.ok) {
    return unsupported(
      "image URL input",
      `Cursor provider could not fetch image URL (HTTP ${response.status})`,
    )
  }
  return {
    data: await readResponseBytes(response, remaining),
    mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined,
    filename: path.basename(value.pathname) || undefined,
  }
}

async function decodeCursorImagePart(
  file: Record<string, unknown>,
  remaining: number,
  signal: AbortSignal | undefined,
  defaultFilename: string,
  resolveLimit = remaining,
): Promise<CursorImageInput> {
  if (typeof file.mediaType !== "string" || !file.mediaType.startsWith("image/")) {
    return unsupported(
      "file input",
      `Cursor provider supports image attachments only, not ${JSON.stringify(file.mediaType)}`,
    )
  }
  if (!(file.data instanceof Uint8Array) && typeof file.data !== "string" && !(file.data instanceof URL)) {
    return unsupported("image input", "Cursor provider received an invalid image data value")
  }

  const resolved = await resolveImageData(
    file.data as Uint8Array | string | URL,
    resolveLimit,
    signal,
  )
  assertImageSize(resolved.data.length, remaining)
  const declaredMimeType = file.mediaType
  const mimeType = declaredMimeType === "image/*"
    ? (resolved.mimeType?.startsWith("image/") ? resolved.mimeType : inferImageMimeType(resolved.data))
    : declaredMimeType
  if (!mimeType?.startsWith("image/") || mimeType === "image/*") {
    return unsupported("image input", "Cursor provider could not determine the image media type")
  }

  return {
    data: resolved.data,
    filename:
      (typeof file.filename === "string" && file.filename ? path.basename(file.filename) : undefined) ??
      resolved.filename ??
      defaultFilename,
    mimeType,
  }
}

export async function extractCursorUserImages(
  lastUser: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  maxBytes = MAX_CURSOR_IMAGE_INPUT_BYTES,
): Promise<CursorImageInput[]> {
  if (!lastUser || !Array.isArray(lastUser.content)) return []

  const byteBudget = cursorImageBudget(maxBytes)
  const images: CursorImageInput[] = []
  let totalBytes = 0
  for (const part of lastUser.content) {
    if (!part || typeof part !== "object") continue
    const file = part as Record<string, unknown>
    if (file.type !== "file") continue
    const image = await decodeCursorImagePart(
      file,
      byteBudget - totalBytes,
      signal,
      `image-${images.length + 1}`,
    )
    totalBytes += image.data.length
    images.push(image)
  }
  return images
}

function cursorHistoryImageParts(prompt: readonly unknown[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  for (const message of prompt) {
    if (!message || typeof message !== "object") continue
    const record = message as Record<string, unknown>
    if (!Array.isArray(record.content)) continue

    if (record.role === "assistant") {
      for (const part of record.content) {
        if (!part || typeof part !== "object") continue
        const file = part as Record<string, unknown>
        if (
          file.type === "file" &&
          typeof file.mediaType === "string" &&
          file.mediaType.startsWith("image/")
        ) parts.push(file)
      }
      continue
    }

    if (record.role !== "tool") continue
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue
      const toolResult = part as Record<string, unknown>
      if (toolResult.type !== "tool-result" || !toolResult.output || typeof toolResult.output !== "object") {
        continue
      }
      const output = toolResult.output as Record<string, unknown>
      if (output.type !== "content" || !Array.isArray(output.value)) continue
      for (const value of output.value) {
        if (!value || typeof value !== "object") continue
        const file = value as Record<string, unknown>
        if (
          file.type === "file-data" &&
          typeof file.mediaType === "string" &&
          file.mediaType.startsWith("image/")
        ) parts.push(file)
      }
    }
  }
  return parts
}

export async function extractCursorHistoryImages(
  prompt: readonly unknown[],
  options: {
    supportsImages: boolean
    seenHashes?: ReadonlySet<string>
    signal?: AbortSignal
    maxBytes?: number
    filenameOffset?: number
  },
): Promise<CursorHistoryImageExtraction> {
  const candidates = cursorHistoryImageParts(prompt)
  if (!options.supportsImages) {
    return { images: [], hashes: [], candidateCount: candidates.length, duplicateCount: 0 }
  }

  const maxBytes = cursorImageBudget(options.maxBytes ?? MAX_CURSOR_IMAGE_INPUT_BYTES)
  const images: CursorImageInput[] = []
  const hashes: string[] = []
  const hashesThisTurn = new Set<string>()
  let duplicateCount = 0
  let totalBytes = 0
  for (const file of candidates) {
    // Resolve against the per-image cap first so a previously sent duplicate
    // does not fail merely because little combined budget remains this turn.
    const image = await decodeCursorImagePart(
      file,
      MAX_CURSOR_IMAGE_INPUT_BYTES,
      options.signal,
      `image-${(options.filenameOffset ?? 0) + images.length + 1}`,
      MAX_CURSOR_IMAGE_INPUT_BYTES,
    )
    const hash = imageContentHash(image.data)
    if (options.seenHashes?.has(hash) || hashesThisTurn.has(hash)) {
      duplicateCount++
      continue
    }
    assertImageSize(image.data.length, maxBytes - totalBytes)
    totalBytes += image.data.length
    images.push(image)
    hashes.push(hash)
    hashesThisTurn.add(hash)
  }

  return { images, hashes, candidateCount: candidates.length, duplicateCount }
}

export async function extractCursorPromptImages(
  prompt: readonly unknown[],
  lastUser: Record<string, unknown> | undefined,
  options: {
    supportsImages: boolean
    seenHistoryHashes?: ReadonlySet<string>
    signal?: AbortSignal
    maxBytes?: number
  },
): Promise<CursorPromptImageExtraction> {
  const maxBytes = cursorImageBudget(options.maxBytes ?? MAX_CURSOR_IMAGE_INPUT_BYTES)
  const userImages = await extractCursorUserImages(lastUser, options.signal, maxBytes)
  const userBytes = userImages.reduce((total, image) => total + image.data.length, 0)
  const history = await extractCursorHistoryImages(prompt, {
    supportsImages: options.supportsImages,
    seenHashes: options.seenHistoryHashes,
    signal: options.signal,
    maxBytes: maxBytes - userBytes,
    filenameOffset: userImages.length,
  })
  return {
    ...history,
    images: [...userImages, ...history.images],
    userImageCount: userImages.length,
  }
}
