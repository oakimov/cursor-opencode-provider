import { createHash } from "node:crypto"

// Content hashes of the history images a session's Cursor conversation holds, so
// growing history does not re-upload old screenshots. Each set belongs to one
// checkpoint: a Run skips an image only when it sends exactly that checkpoint.

/** Mirrors MAX_TURN_STATE_SESSIONS. */
const MAX_SESSIONS = 256
const MAX_IMAGES_PER_SESSION = 256
/** A stopped or failed turn leaves the next Run on one of its intermediate checkpoints. */
const MAX_CHECKPOINTS_PER_SESSION = 32

/** `hashes` is shared between entries and never mutated. */
type HeldImages = { conversationId: string; checkpoint: string; hashes: readonly string[] }

/** Newest first. */
const heldBySession = new Map<string, HeldImages[]>()

/**
 * One Run's view: `held` by the checkpoint it last stood on, `checkpointed` sent
 * before Cursor's latest checkpoint arrived, `sent` since, each with the last
 * frame arrival at its send. Only a turn that ends on a checkpoint of its own
 * moves `checkpointed` into `held`.
 */
export type RunHistoryImages = {
  held: readonly string[]
  checkpointed: string[]
  sent: Array<{ hash: string; afterArrival: number }>
}

export function checkpointFingerprint(checkpoint: Uint8Array): string {
  return createHash("sha256").update(checkpoint).digest("hex")
}

function newest(hashes: Iterable<string>): string[] {
  const unique = [...new Set([...hashes].reverse())].reverse()
  return unique.slice(Math.max(0, unique.length - MAX_IMAGES_PER_SESSION))
}

function touch(sessionKey: string, entries: HeldImages[]): void {
  heldBySession.delete(sessionKey)
  if (entries.length === 0) return
  heldBySession.set(sessionKey, entries.slice(0, MAX_CHECKPOINTS_PER_SESSION))
  while (heldBySession.size > MAX_SESSIONS) {
    const oldest = heldBySession.keys().next().value as string | undefined
    if (!oldest) break
    heldBySession.delete(oldest)
  }
}

function find(sessionKey: string, conversationId: string, checkpoint: Uint8Array): HeldImages | undefined {
  const entries = heldBySession.get(sessionKey)
  if (!entries) return undefined
  const fingerprint = checkpointFingerprint(checkpoint)
  return entries.find((entry) => entry.conversationId === conversationId && entry.checkpoint === fingerprint)
}

/** The images `checkpoint` is known to hold. */
export function heldHistoryImageHashes(
  sessionKey: string,
  conversationId: string,
  checkpoint: Uint8Array,
): ReadonlySet<string> | undefined {
  const entry = find(sessionKey, conversationId, checkpoint)
  if (!entry) return undefined
  touch(sessionKey, heldBySession.get(sessionKey)!)
  return new Set(entry.hashes)
}

function recordHeldHistoryImages(
  sessionKey: string,
  conversationId: string,
  checkpoint: Uint8Array,
  hashes: readonly string[],
): void {
  if (hashes.length === 0) return
  const entry = { conversationId, checkpoint: checkpointFingerprint(checkpoint), hashes }
  const others = (heldBySession.get(sessionKey) ?? [])
    .filter((other) => other.conversationId !== conversationId || other.checkpoint !== entry.checkpoint)
  touch(sessionKey, [entry, ...others])
}

export function runHistoryImages(held?: ReadonlySet<string>): RunHistoryImages {
  return { held: [...(held ?? [])], checkpointed: [], sent: [] }
}

/** The images a checkpoint that arrived at `arrival` holds: those the Run stood on and those it sent before. */
export function historyImagesHeldAt(run: RunHistoryImages, arrival = Infinity): string[] {
  return newest([
    ...run.held,
    ...run.checkpointed,
    ...run.sent.filter((image) => image.afterArrival < arrival).map((image) => image.hash),
  ])
}

/**
 * A Run that resumes another Run's checkpoint continues that turn. The images
 * the checkpoint holds count, like the Run's own, once its turn ends on a
 * checkpoint of its own.
 */
export function carryHistoryImages(run: RunHistoryImages, hashes: readonly string[]): void {
  for (const hash of hashes) {
    if (!run.held.includes(hash) && !run.checkpointed.includes(hash)) run.checkpointed.push(hash)
  }
}

/** The image is in this Run's conversation: held by its checkpoint, or sent by the Run. */
export function runHasHistoryImage(run: RunHistoryImages, hash: string): boolean {
  return run.held.includes(hash)
    || run.checkpointed.includes(hash)
    || run.sent.some((image) => image.hash === hash)
}

/** `lastArrival`: the last frame arrival once the images are written. */
export function noteHistoryImagesSent(run: RunHistoryImages, hashes: readonly string[], lastArrival = 0): void {
  run.sent.push(...hashes.map((hash) => ({ hash, afterArrival: lastArrival })))
}

/**
 * Cursor's checkpoints extend the one the Run started on, so each holds at least what that one held.
 * A checkpoint that arrived before images were written (read only after a host tool's result) holds none of them.
 */
export function noteHistoryImageCheckpoint(
  run: RunHistoryImages,
  sessionKey: string,
  conversationId: string,
  checkpoint: Uint8Array,
  arrival = Infinity,
): void {
  const later = run.sent.findIndex((image) => image.afterArrival >= arrival)
  const earlier = later < 0 ? run.sent.length : later
  run.checkpointed.push(...run.sent.slice(0, earlier).map((image) => image.hash))
  run.sent = run.sent.slice(earlier)
  recordHeldHistoryImages(sessionKey, conversationId, checkpoint, run.held)
}

/**
 * The turn ended. On a checkpoint of its own, that checkpoint holds what the Run
 * sent before it; without one, nothing the Run sent counts as held.
 */
export function confirmHistoryImagesAtTurnEnd(
  run: RunHistoryImages,
  sessionKey: string,
  conversationId: string,
  checkpoint: Uint8Array | undefined,
): void {
  if (checkpoint?.length) {
    run.held = newest([...run.held, ...run.checkpointed])
    recordHeldHistoryImages(sessionKey, conversationId, checkpoint, run.held)
  }
  run.checkpointed = []
  run.sent = []
}

/** For the restart snapshot: the set the checkpoint being saved holds. */
export function heldHistoryImagesSnapshot(
  sessionKey: string,
  conversationId: string,
  checkpoint: Uint8Array | undefined,
): { checkpoint: string; hashes: string[] } | undefined {
  const entry = checkpoint?.length ? find(sessionKey, conversationId, checkpoint) : undefined
  return entry ? { checkpoint: entry.checkpoint, hashes: [...entry.hashes] } : undefined
}

export function restoreHeldHistoryImages(
  sessionKey: string,
  conversationId: string,
  saved: { checkpoint?: string; hashes?: readonly string[] },
): void {
  touch(sessionKey, saved.checkpoint && saved.hashes?.length
    ? [{ conversationId, checkpoint: saved.checkpoint, hashes: newest(saved.hashes) }]
    : [])
}

export function forgetHeldHistoryImages(sessionKey: string): void {
  heldBySession.delete(sessionKey)
}

export function snapshotHeldHistoryImagesForTests(sessionKey: string): HeldImages[] {
  return (heldBySession.get(sessionKey) ?? []).map((entry) => ({ ...entry, hashes: [...entry.hashes] }))
}

export function resetHeldHistoryImagesForTests(): void {
  heldBySession.clear()
}
