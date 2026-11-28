/**
 * A Run without a checkpoint carries its history as up to five
 * `prepend_user_messages` (earlier user turns) and only the request in
 * `user_message.text`. Tests that check what a seed carries read both, in the
 * order Cursor sees them.
 */
type DecodedUserMessageAction = {
  user_message?: { text?: string }
  prepend_user_messages?: Array<{ text?: string }>
} | undefined

/** Prepended history parts, then the live user text, joined as Cursor reads them. */
export function seedText(action: DecodedUserMessageAction): string {
  const parts = (action?.prepend_user_messages ?? []).map((part) => part.text ?? "")
  return [...parts, action?.user_message?.text ?? ""].join("\n\n")
}

/** Whether the Run seeded host history (any prepended earlier turn). */
export function hasSeedHistory(action: DecodedUserMessageAction): boolean {
  return (action?.prepend_user_messages ?? []).some((part) => (part.text ?? "").includes("<conversation_history>"))
}
