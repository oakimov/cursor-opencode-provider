import { CURSOR_IMAGE_INPUT } from "./image-input-data.js"
import { CURSOR_MODEL_CONTEXTS } from "./pricing-data.js"

export type CursorModelContext = {
  maxContext?: number
  maxContextForMaxMode?: number
}

export function getDocumentedCursorModelContext(
  modelId: string,
): CursorModelContext | undefined {
  const context = (CURSOR_MODEL_CONTEXTS as Record<string, CursorModelContext>)[modelId]
  return context ? { ...context } : undefined
}

/**
 * Image input is advertised unless our live probe (`bun run generate:images`)
 * explicitly recorded that the model's Run does not read images. Unrecorded
 * models default to image-capable, matching Cursor CLI / IDE behavior.
 * Cursor's AvailableModels flag is not used.
 */
export function cursorModelReadsImages(modelId: string): boolean {
  return !(
    Object.hasOwn(CURSOR_IMAGE_INPUT, modelId) &&
    (CURSOR_IMAGE_INPUT as Record<string, boolean>)[modelId] === false
  )
}
