/**
 * Work for the end of every test. `test/preload.ts` runs it after the test's
 * own hooks. Bun runs those hooks for a test that timed out and lets its body
 * keep running, so this is where process-wide state that a body holds is put
 * back before the next test starts.
 */
const work = new Set<() => void>()

export function atTestEnd(run: () => void): void {
  work.add(run)
}

export function runTestEnd(): void {
  for (const run of work) run()
}
