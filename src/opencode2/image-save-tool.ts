import path from "node:path"
import { executeCursorImageSave, type ImageSaveToolContext } from "../image-save.js"
import { cursorImageSaveTool } from "../image-save-tool.js"
import { CURSOR_IMAGE_SAVE_TOOL } from "../protocol/generate-image.js"
import { getSessionDirectory } from "../session-directory.js"
import { hostHasTool, OPENCODE2_DIRECT_TOOL_OPTIONS } from "./todo-tools.js"
import type { PermissionDomain, PluginContext, ToolDraft, ToolExecutionContext } from "./types.js"

type ImageSaveAsk = NonNullable<ImageSaveToolContext["ask"]>
type ImageSaveExecutionContext = Partial<Pick<ToolExecutionContext, "sessionID" | "agent" | "messageID" | "id">>

/**
 * OpenCode 2's tag for a plain permission rejection (`Permission.DeclinedError`).
 * The host recognizes it only by identity on the error a tool rethrows, and
 * then ends the step instead of handing the model a tool failure.
 */
const PLAIN_DECLINE_TAG = "Permission.DeclinedError"

function isPlainDecline(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { _tag?: unknown })._tag === PLAIN_DECLINE_TAG
}

const slash = (value: string) => value.replaceAll("\\", "/")

/**
 * Adapt the shared helper's classic `ask` requests to the public plugin
 * `permission.assert`. Native file tools name an internal target by its
 * workspace-relative path and an external one by its absolute path, while the
 * shared edit pattern is always worktree-relative, so an external edit uses the
 * absolute `metadata.filepath` instead.
 */
function assertPermission(
  permission: PermissionDomain,
  sessionID: string,
  context: ImageSaveExecutionContext,
  onDecline: (error: unknown) => void,
): ImageSaveAsk {
  return async (request) => {
    const filepath = request.metadata.filepath
    const externalEdit = request.permission === "edit" && request.patterns.some(
      (pattern) => pattern === ".." || pattern.startsWith(`..${path.sep}`) || path.isAbsolute(pattern),
    )
    try {
      await permission.assert({
        sessionID,
        ...(typeof context.agent === "string" ? { agent: context.agent } : {}),
        action: request.permission,
        resources: (externalEdit && typeof filepath === "string" ? [filepath] : request.patterns).map(slash),
        save: request.always.map(slash),
        metadata: request.metadata,
        ...(typeof context.messageID === "string" && typeof context.id === "string"
          ? { source: { type: "tool" as const, messageID: context.messageID, id: context.id } }
          : {}),
      })
    } catch (error) {
      if (isPlainDecline(error)) onDecline(error)
      throw error
    }
  }
}

const IMAGE_SAVE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    image_id: {
      type: "string",
      description: "Id of the pending Cursor-generated image to save",
    },
  },
  required: ["image_id"],
} as const

const IMAGE_SAVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    bytes: { type: "number" },
    message: { type: "string" },
  },
  required: ["path", "bytes", "message"],
} as const

function toolAsk(context: unknown):
  | ((input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }) => Promise<void>)
  | undefined {
  if (!context || typeof context !== "object") return undefined
  const ask = (context as { ask?: unknown }).ask
  return typeof ask === "function"
    ? (ask as (input: {
      permission: string
      patterns: string[]
      always: string[]
      metadata: Record<string, unknown>
    }) => Promise<void>)
    : undefined
}

async function workspaceForSession(
  ctx: PluginContext,
  sessionID: string,
): Promise<string> {
  const marked = getSessionDirectory(sessionID)
  if (marked) return marked
  try {
    return (await ctx.session.get({ sessionID })).location.directory
  } catch {
    return ctx.location?.directory || process.cwd()
  }
}

/**
 * Register the handle-only image commit tool on the OpenCode 2.0 direct
 * catalog. Catalog `permission: "edit"` hides it when the host agent denies
 * edits. The public plugin permission domain then asks `external_directory`
 * and `edit` per write; 2.0 snapshots without it keep the containment-only
 * gate (opaque `image_id` only).
 */
export function registerCursorImageSaveTool(draft: ToolDraft, ctx: PluginContext): void {
  if (hostHasTool(draft, CURSOR_IMAGE_SAVE_TOOL)) return

  draft.add({
    name: CURSOR_IMAGE_SAVE_TOOL,
    description: cursorImageSaveTool.description,
    input: IMAGE_SAVE_INPUT_SCHEMA,
    output: IMAGE_SAVE_OUTPUT_SCHEMA,
    options: { ...OPENCODE2_DIRECT_TOOL_OPTIONS, permission: "edit" },
    execute: async (input: { image_id?: unknown }, context: ImageSaveExecutionContext) => {
      const sessionID = context.sessionID
      if (typeof sessionID !== "string" || !sessionID) {
        throw new Error("OpenCode 2.0 image-save context did not provide a sessionID")
      }
      const directory = await workspaceForSession(ctx, sessionID)
      let decline: { error: unknown } | undefined
      const result = await executeCursorImageSave(
        { image_id: input?.image_id },
        {
          worktree: directory,
          directory,
          // Without the permission domain, catalog `permission: "edit"` and
          // containment gate the write.
          ask: ctx.permission
            ? assertPermission(ctx.permission, sessionID, context, (error) => {
              decline = { error }
            })
            : toolAsk(context) ?? null,
        },
      ).catch((error: unknown) => {
        // The shared helper marks refusals so Cursor gets `permission_denied`.
        // A plain decline must instead reach the host unchanged to end the step;
        // deny rules and feedback stay marked for Cursor.
        throw decline ? decline.error : error
      })
      return {
        output: {
          path: result.title,
          bytes: result.bytes,
          message: result.output,
        },
        content: result.output,
      }
    },
  })
}
