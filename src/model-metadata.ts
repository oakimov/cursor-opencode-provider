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
 * Image input only where our live probe saw the model's Run read an image
 * (`bun run generate:images`). Cursor's AvailableModels flag is not used.
 */
export function cursorModelReadsImages(modelId: string): boolean {
  return (CURSOR_IMAGE_INPUT as Record<string, boolean>)[modelId] === true
}
