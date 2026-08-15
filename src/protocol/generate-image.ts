/**
 * Cursor-native GenerateImage.
 *
 * Cursor generates the image on its own servers, then writes it to the client
 * exactly like any other file — Cursor CLI's agent issues
 * `WriteArgs{path, file_bytes, return_file_content_after_write: false}` to
 * `<artifactsFolder|projectFolder>/assets/<basename(file_path)>` and reads the
 * client's `WriteResult` back, checking for `permission_denied`
 * (`agent-cli-local/src/index.ts:84752-84776`).
 *
 * The display `generate_image_tool_call.result.image_data` is **not** the write
 * channel: the CLI feeds it to its terminal preview cache and falls back to
 * reading the path off disk, so the file already exists by then. Never write
 * from that frame — the bytes would be written twice.
 *
 * So the client-side work is: approve the interaction, then honour a binary
 * write. OpenCode's `write` tool cannot carry bytes (string content, BOM split,
 * diff, `Format.file()`), so the bytes are staged (`../image-staging.ts`) and
 * committed by the `cursor_image_save` plugin tool, which raises OpenCode's
 * `edit` permission. A refusal returns Cursor's own `permission_denied`.
 */

import path from "node:path"
import { decodeMessageSparse } from "./messages.js"

/** Host tool id that commits a staged image. Registered by the classic plugin. */
export const CURSOR_IMAGE_SAVE_TOOL = "cursor_image_save"

/** Cursor's agent always writes generated images into this subdirectory. */
export const CURSOR_IMAGE_ASSETS_DIR = "assets"

export type DecodedGenerateImageQuery = {
  description: string
  /** Target path as Cursor asked for it; may be relative or empty. */
  filePath: string
  referenceImagePaths: string[]
  toolCallId: string
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** Cursor names the target file; its extension is the only mime signal sent. */
export function imageMimeForPath(filePath: string): string {
  const dot = path.basename(filePath).lastIndexOf(".")
  if (dot <= 0) return "image/png"
  return IMAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "image/png"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Decode a `generate_image_request_query` body, or undefined when unusable. */
export function decodeGenerateImageQuery(
  queryBytes: Uint8Array,
): DecodedGenerateImageQuery | undefined {
  let decoded: Record<string, unknown>
  try {
    decoded = decodeMessageSparse("GenerateImageRequestQuery", queryBytes)
  } catch {
    return undefined
  }
  const args = asRecord(decoded.args)
  if (!args) return undefined
  const description = str(args.description)
  if (!description) return undefined
  return {
    description,
    filePath: str(args.file_path),
    referenceImagePaths: Array.isArray(args.reference_image_paths)
      ? args.reference_image_paths.filter((item): item is string => typeof item === "string")
      : [],
    toolCallId: str(decoded.tool_call_id),
  }
}

export type ImageWriteRoots = {
  /** Session workspace root (`request_context.env.workspace_paths[0]`). */
  workspaceRoot: string
  /** What this provider advertises as `project_folder` / `workspace_project_dir`. */
  projectDir: string
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Map Cursor's intended write target onto a real location under this host.
 *
 * Cursor composes the path from the `project_folder` this provider advertised,
 * so an untouched target already resolves under the host cache project
 * directory and is kept as-is. A target inside the workspace is also honoured
 * verbatim — that is a location the user can see. Anything else (a path built
 * from a folder we never advertised, or an attempted escape) is rebased onto
 * `<projectDir>/assets/<basename>` rather than refused, so the model still gets
 * a file where it expects one instead of a failed generation.
 */
export function remapCursorImageWritePath(target: string, roots: ImageWriteRoots): string {
  const projectDir = path.resolve(roots.projectDir)
  const assets = path.join(projectDir, CURSOR_IMAGE_ASSETS_DIR)
  const fallback = path.join(assets, path.basename(target) || "generated-image.png")

  if (!target) return fallback
  const absolute = path.isAbsolute(target) ? target : path.resolve(projectDir, target)
  if (isInside(projectDir, absolute)) return path.resolve(absolute)
  if (roots.workspaceRoot && isInside(roots.workspaceRoot, absolute)) return path.resolve(absolute)
  return fallback
}
