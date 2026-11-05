import { CURSOR_MODEL_CAPABILITIES, CURSOR_MODEL_CONTEXTS } from "./pricing-data.js"

export type CursorModelContext = {
  maxContext?: number
  maxContextForMaxMode?: number
}

export type CursorModelCapabilities = {
  supportsImages: boolean
}

export function getDocumentedCursorModelContext(
  modelId: string,
): CursorModelContext | undefined {
  const context = (CURSOR_MODEL_CONTEXTS as Record<string, CursorModelContext>)[modelId]
  return context ? { ...context } : undefined
}

export function getDocumentedCursorModelCapabilities(
  modelId: string,
): CursorModelCapabilities | undefined {
  const capabilities = (
    CURSOR_MODEL_CAPABILITIES as Record<string, CursorModelCapabilities>
  )[modelId]
  return capabilities ? { ...capabilities } : undefined
}

export function resolveCursorModelSupportsImages(
  modelId: string,
  availableModelsValue?: boolean,
): boolean {
  // AvailableModels reports false for Grok 4.7 even though Cursor's Run
  // accepts images (verified with shape/color recognition and image-only text).
  // Keep this correction on the wire id so every context/Fast catalog alias
  // shares it; other models still respect explicit negative live metadata.
  if (modelId === "grok-4.7") return true
  return availableModelsValue ?? getDocumentedCursorModelCapabilities(modelId)?.supportsImages ?? false
}
