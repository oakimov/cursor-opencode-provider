import { tool } from "@opencode-ai/plugin"
import { executeCursorImageSave } from "./image-save.js"

/**
 * Classic-plugin registration for committing a Cursor-generated image.
 *
 * Kept apart from `./image-save.ts` for the same reason as
 * `./web-search-tool.ts`: this is a *value* import from `@opencode-ai/plugin`,
 * whose package root exports no `tool` on the OpenCode 2.0 dist-tag. Only
 * `plugin.ts` (classic hooks) may import this file.
 *
 * The argument list is deliberately just a handle. This is not a file writer:
 * without a staged image from this process there is nothing to write, and the
 * path is never accepted from the caller.
 */
export const cursorImageSaveTool = tool({
  description:
    "Save an image that Cursor generated during this session to its target path. "
    + "Takes only the id of an already-generated image — it cannot write arbitrary "
    + "files, and it is not a general-purpose file writer. You do not normally call "
    + "this: the Cursor provider issues it after an image is generated.",
  args: {
    image_id: tool.schema
      .string()
      .describe("Id of the pending Cursor-generated image to save"),
  },
  execute: executeCursorImageSave,
})
