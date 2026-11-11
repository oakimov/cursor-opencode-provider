# Review harness setup

First-time guide for maintainers: supply credentials, run a review, and
understand what GitHub receives.

Agents follow the detailed procedure in [pr-review.md](pr-review.md). Review
criteria are in [review-rules.md](review-rules.md).

Nothing in this repository starts a review automatically. You launch one Cursor
Cloud Agent (or run the publisher locally), read the preview, then approve a
send. Approval to post is not approval to merge.

## Harness architecture

### What it does

The harness is the maintainer tooling around a manual `caeliq-reviewer` review.
It does **not** decide that a diff is correct; a human (or Cloud Agent following
[pr-review.md](pr-review.md)) still reads the code. The harness:

1. **Isolates untrusted PR code** — `scripts/isolated-check.sh` archives the PR
   head and runs install/build/typecheck/tests inside a Linux namespace or macOS
   sandbox. Review-posting secrets stay outside that boundary.
2. **Structures the review** — the agent writes a private ledger
   (`scripts/review-ledger.py`) and a structured `review.json`, then
   `scripts/review-publish.py` renders a COMMENT payload.
3. **Gates publication** — `show` freezes bytes and prints `PREVIEW_SHA256=`;
   only an exact local `approve` lets `post` talk to GitHub. Artifacts live in
   gitignored `.review-artifacts/` (or `REVIEW_ARTIFACT_DIR`).
4. **Optionally live-tests the plugin** — after a separate trust decision,
   `--live` runs OpenCode against this checkout with `CURSOR_API_KEY`.

Trusted local edits use `scripts/test-harness.py` (full suite / Docker backend).
That path is not the untrusted-PR boundary.

| Piece | Role |
|-------|------|
| `.cursor/skills/review/SKILL.md` | Agent review procedure |
| `docs/pr-review.md` | Agent publication / isolation rules |
| `scripts/review-publish.py` | start → bind → render → stamp → show → approve/deny → post |
| `scripts/review-ledger.py` | private completion evidence |
| `scripts/isolated-check.sh` / `isolate-run.sh` | untrusted PR checks |
| `scripts/complete-resolutions.py` | finish approved thread resolves after a confirmed review |
| `scripts/cloud-agent-install.sh` | Cloud Agent bootstrap |
| `eval/review/` | offline detection fixtures and scorer |

### What the automated tests cover

`bun test` exercises harness correctness with fakes — no live GitHub, no Cloud
Agent, no model call, and (unless a test opts in under the network guard) no
Cursor. Passing tests do **not** mean the review skill finds real defects.

| Suite | File | Focus |
|-------|------|-------|
| Publication | `test/review-publish.test.ts` | App/PAT auth, preview approval, idempotent post, privacy refusals, artifact retention, thread resolve, evidence/ledger gate |
| Isolation / live scripts | `test/review-scripts.test.ts` | Cloud install string, isolated-check targets, sandbox PATH/secrets, live-test skip/deadline/cleanup, pid-targeted cancel |
| Eval fixtures / scorer | `test/review-eval.test.ts` | Case orchestration fixtures, mount excludes answer keys, ledger compare, score detection vs false positives |

The test preload clears inherited `CURSOR_PROVIDER_CACHE_TTL_MS` so expiry
fixtures use the default policy. A test may set its own override and pass it
to child writers, but must restore it before returning. A leaked override
fails that test and is cleared before the next one. Subprocess regressions in
`test/test-isolation.test.ts` exercise inherited settings and that recovery.

### Live OpenCode tests

Unit tests never load a real OpenCode process against Cursor. The live path
does: it builds this package, writes a private OpenCode config that loads the
checkout's plugin, and runs a non-interactive `opencode run --standalone` that
must reply exactly `pong`.

`scripts/live-test.sh` (via `bun run live-test`):

- Loads **OpenCode 2.x** (`opencode` → `dist/plugin-opencode2.js`) and
  **OpenCode 1.x** (`opencode1` → `dist/plugin.js`). A missing binary for either
  major fails the run.
- Requires `CURSOR_API_KEY` (Cursor user API key from
  [cursor.com/settings](https://cursor.com/settings)). If unset, prints
  `LIVE_TEST=skipped` and exits 0 — it does not call Cursor.
- Uses `scripts/configure-opencode.sh` as the only config writer (default
  `.opencode-local/`; `OPENCODE_REVIEW_HOME` relocates the private roots).
- Refuses to prompt until `opencode plugin list` shows the plugin import once,
  then requires `setup` once. Default model is `cursor/composer-2.5`
  (`OPENCODE_LIVE_MODEL` overrides it).
- Needs a deadline command: GNU `timeout` / `gtimeout`, or `LIVE_TEST_TIMEOUT`
  naming an executable that accepts `SECONDS COMMAND...`.

**Trusted local checkout** (your own tree, not an untrusted PR archive):

```bash
bun run build
bash scripts/configure-opencode.sh
export CURSOR_API_KEY=...   # required to actually run; otherwise skipped
bun run live-test
```

**Untrusted pull request** — only after isolated checks pass **and** an
explicit trust decision for that exact commit:

```bash
scripts/isolated-check.sh <pr-number-or-url>          # no key yet
# After you decide to trust the printed/archived commit SHA:
CURSOR_REVIEW_TRUST=1 CURSOR_REVIEW_TRUST_SHA=<40-char-sha> \
  scripts/isolated-check.sh <pr-number-or-url> --live
```

`--live` re-fetches the PR head, refuses a SHA other than the trusted one, and
only then forwards `CURSOR_API_KEY` into a fresh boundary that runs **this
checkout's** `scripts/live-test.sh` (read-only harness mount + private config
under the boundary temp). Passing unit tests never sets the trust variables. A
failed check never receives the key. The PR's own `scripts/live-test.sh` is not
executed.

#### Incorporating a live test into a review

1. Run it when the diff can break real OpenCode ↔ Cursor behavior: provider,
   protocol, transport, session, entrypoints, tools, auth, or anything unit
   tests do not exercise in a live process.
2. Skip it for docs, rules, or refactors the unit suite already covers — say
   why in the private review notes / check detail.
3. Record the live check in `review.json` like any other command check (name,
   status, `exitCode`, detail). Keep OpenCode version and plugin path in the
   **private** log; they do not belong in the public COMMENT body.
4. A live `pong` only proves plugin load and the reply path. It is not a
   substitute for reading the diff, the ledger completion passes, or eval
   detection scores.
5. To extend coverage, tighten assertions inside `scripts/live-test.sh` /
   `scripts/live-reply.py`, or add script-level regressions under
   `test/review-scripts.test.ts` (fake OpenCode, no Cursor). Do not add
   `bun test` cases that require a real `CURSOR_API_KEY` or network to Cursor.

### What evals are

`eval/review/` is a **manual detection check**: prepare a blind mount, have a
fresh reviewer produce `ledger.json` + `review.json`, then score. It never
publishes. Details: [eval/review/README.md](../eval/review/README.md).

```bash
python3 scripts/review-eval.py list
python3 scripts/review-eval.py prepare --case <id> --variant <name> --skill revised --out <dir>
# give the reviewer only <dir>/mount/ …
python3 scripts/review-eval.py score --case <id> --variant <name> \
  --review review.json --ledger ledger.json
```

- **Cases** live under `eval/review/cases/<id>/` (`base/` + `overlays/<variant>/`).
- **Answer keys** live only under `eval/review/private/<id>.json` (never in the mount).
- **Skills:** `--skill baseline` uses the frozen snapshot in
  `eval/review/baseline/`; `--skill revised` uses the current skill and guides.
- A defect counts as detected when a finding names the file and states the
  answer key's causal groups — not by title wording. Held-out cases
  (`heldout=true` in the private key) must not steer skill wording.

### Adding tests or scenarios

**Publisher / isolation regression** — add a case to the matching
`test/review-*.test.ts` file. Prefer the existing fake `gh` / sandbox patterns;
do not call GitHub or Cursor from tests.

**New eval scenario**

1. Add `eval/review/cases/<id>/base/` with a small self-contained subject
   (contract, code, tests as needed).
2. Add `overlays/<variant>/` patches (for example `buggy` / `fixed`).
3. Add `eval/review/private/<id>.json` with `heldout`, per-variant `defects` /
   `nonDefects` / `absentDefects` (paths + causal token groups). Keep the key
   out of the skill, prompt, and scorer hardcoding.
4. If the case has real orchestration worth locking in, add a fixture assertion
   in `test/review-eval.test.ts` (liveness after owner return, consumer parity,
   and so on). Those fixture checks are not detection scores.
5. `python3 scripts/review-eval.py list` should show the new id; `prepare` +
   `verify-mount` before any blind reviewer run.

Do not copy expected findings into `.cursor/skills/review/` or the offline
`PROMPT.txt` adapter. If no fresh blind reviewer ran, treat detection as
unverified.

## Setup

You need **either** GitHub App credentials **or** a personal access token (PAT).
The publisher uses one credential for every `gh` call in `post`, `threads`, and
`complete-resolutions.py`. There is no fallback from App failure to a PAT, or to
a discussion comment. The Cloud Agent `gh` login and an App client secret are
not publishing credentials.

Also needed on the machine that runs the publisher: `python3`, `gh`, and
(for the App path) `openssl`.

### GitHub App credentials

Default path. The review author is the App bot (this repository uses
`caeliq-reviewer`). The App must already be installed on the target repository
with pull-request write access (needed for the review POST and for
`resolveReviewThread` on re-review).

| Variable | Required | Purpose |
|----------|----------|---------|
| `REVIEW_APP_ID` | yes | numeric App ID |
| `REVIEW_APP_PRIVATE_KEY` | yes, unless using the file form | PEM private key body |
| `REVIEW_APP_PRIVATE_KEY_FILE` | alternative to the inline key | path to an owner-only regular PEM file (not group- or world-readable) |
| `REVIEW_APP_INSTALLATION_ID` | no | when unset, `post` looks up the installation for the PR's `owner/repo` |

Set only one of `REVIEW_APP_PRIVATE_KEY` and `REVIEW_APP_PRIVATE_KEY_FILE`.

**Cursor Cloud Agent:** store `REVIEW_APP_ID` and `REVIEW_APP_PRIVATE_KEY` as
Runtime Secrets (and `REVIEW_APP_INSTALLATION_ID` if you use it). Cloud Agents
bootstrap from `.cursor/environment.json` → `scripts/cloud-agent-install.sh`.

**Local machine:** export the same variables in the shell that will run
`review-publish.py`, or point `REVIEW_APP_PRIVATE_KEY_FILE` at a private PEM.

Omit `--token-env` so `post` mints an installation token scoped to the
repository. That token keeps the installation's granted permissions; the
returned grant must include `pull_requests: write`.

### Personal access token

Use a classic or fine-grained PAT (`ghp_…` or `github_pat_…`) when you want the
review authored by a user account, or when App secrets are unavailable.

1. Put the token in an environment variable whose name you choose (for example
   `REVIEW_PAT`). Never pass the token value on the command line.
2. Pass that **variable name** with `--token-env`:

```bash
export REVIEW_PAT=...   # prefer a secret store / paste that avoids shell history
python3 scripts/review-publish.py post --token-env REVIEW_PAT \
  "$review_dir/payload.json" "$review_dir/approval.json"
```

The named token wins over an ambient `GH_TOKEN` or `GITHUB_TOKEN`.

### Optional: Cursor API key for the live plugin test

Reviews do not need a Cursor key to publish. `CURSOR_API_KEY` is only for the
optional live OpenCode smoke test described under
[Live OpenCode tests](#live-opencode-tests). Without the key, `bun run live-test`
prints `LIVE_TEST=skipped` and exits 0. For an untrusted PR, also set
`CURSOR_REVIEW_TRUST=1` and `CURSOR_REVIEW_TRUST_SHA` to the reviewed commit
before `isolated-check.sh … --live`; passing unit tests is not that decision.

### Verify configuration

Without contacting GitHub or printing secrets:

```bash
python3 scripts/review-publish.py auth-info
```

Confirm the environment flags you expect. This does not prove write access; the
first approved `post` does.

## How to use

### Start a Cloud Agent review

1. Finish [Setup](#setup) so App Runtime Secrets (or a PAT you will pass with
   `--token-env`) are available.
2. Launch **one** Cursor Cloud Agent on this repository.
3. Paste an instruction that names the pull request. Substitute the URL:

```text
Review https://github.com/oakimov/cursor-opencode-provider/pull/N.
Follow .cursor/skills/review/SKILL.md and docs/pr-review.md.
Read the diff, the files it changes, their callers, docs/review-rules.md, and the existing review threads.
Run scripts/isolated-check.sh on that pull request.
Perform the review procedure in `.cursor/skills/review/SKILL.md`: inventory behaviors, trace consumers, falsify candidates, then run the omission pass as a separate check, and run the failed-work retry check (the two-invocation sequence) for each relevant stateful operation. Keep the private ledger out of the payload.
Record that revision, render one structured COMMENT review with scripts/review-publish.py, and show the payload.
Use review-publish.py start for a persistent workspace. Keep the review files until confirmed publication or an explicit instruction to discard; never remove them during temporary cleanup.
Stop. Do not post, approve, or merge. An incomplete result is not a finished review.
```

4. Wait until the agent stops after `show` and reports `PREVIEW_SHA256=` (stderr).
5. Read the preview yourself. Check findings, paths, and that no secrets or
   private local paths appear.

### Approve or refuse the preview

Artifacts live under gitignored `.review-artifacts/` by default (`REVIEW_ARTIFACT_DIR`
can point at another persistent volume — not TMPDIR).

```bash
# Approve the exact digest show printed, then publish with the App:
python3 scripts/review-publish.py approve \
  "$review_dir/payload.json" "$review_dir/approval.json" "$PREVIEW_SHA256"
python3 scripts/review-publish.py post \
  "$review_dir/payload.json" "$review_dir/approval.json"

# Same publish with a PAT:
python3 scripts/review-publish.py post --token-env REVIEW_PAT \
  "$review_dir/payload.json" "$review_dir/approval.json"

# Refuse — post then makes no GitHub call:
python3 scripts/review-publish.py deny "$review_dir/approval.json"
```

If the payload changes after `show`, run `show` again and approve the new
digest. If the PR head moved, refresh the review and approve again. Keep the
workspace until confirmed publication or an explicit discard:

```bash
python3 scripts/review-publish.py cleanup "$review_dir"
python3 scripts/review-publish.py cleanup "$review_dir" \
  --discard-instruction "Discard this review."
```

If a confirmed review left approved thread resolutions unfinished:

```bash
python3 scripts/complete-resolutions.py \
  "$review_dir/payload.json" "$review_dir/approval.json"
# or: ... --token-env REVIEW_PAT ...
```

### Run the same flow locally

On a trusted machine with `python3`, `gh`, and (for the App path) `openssl`:

```bash
# Untrusted PR checks (harness checkout stays outside the archive):
scripts/isolated-check.sh <pr-number-or-url>

review_dir="$(python3 scripts/review-publish.py start owner repo N)"
python3 scripts/review-publish.py bind owner repo N "$review_dir/review.json"
# Produce review.json + ledger.json in that workspace (same schema as the agent),
# then:
python3 scripts/review-ledger.py check "$review_dir/ledger.json"
python3 scripts/review-ledger.py compare "$review_dir/ledger.json" "$review_dir/review.json"
python3 scripts/review-publish.py render "$review_dir/review.json" "$review_dir/payload.json"
python3 scripts/review-publish.py stamp "$review_dir/payload.json"
python3 scripts/review-publish.py show "$review_dir/payload.json"
# Then approve + post as above.
```

For trusted local edits (not an untrusted PR), `python3 -B scripts/test-harness.py`
(`python -B` on Windows) runs the full suite; `--diagnose` reports the selected
backend. Details of that runner stay in [pr-review.md](pr-review.md#local-checks-on-different-operating-systems).

## What gets posted

Only after `approve` of the exact preview digest does `post` call GitHub. It
creates an initial **pull-request review**, or updates that review's summary
on re-review:

| Piece | Content |
|-------|---------|
| Author | App bot (default), or the user account for a `--token-env` PAT |
| Event | `COMMENT` only — never Approve or Request changes |
| Commit | initial review: the approved `head` SHA; updates keep the original metadata and name the new head in the summary |
| Summary body | review summary text, plus a stamp `<!-- cursor-review:<digest> -->` used to find the same review on retry |
| Inline comments | optional; each has repository-relative `path`, diff `line`, `side` (`LEFT`/`RIGHT`), and `body` |

Inline comments are only for findings on the current diff. Notes that are not
anchored there stay in the summary. A clean review still goes through this
publisher: non-empty summary, empty `comments` array.

Do **not** post with a PR discussion comment, `gh pr comment`, or the agent's
chat reply. Those are not a submitted review receipt.

On a re-review, the approved payload may list `resolve` actions for earlier
threads. First use `review-publish.py reviews` to inventory this reviewer's
existing post and set the result's `update` target as described in
[re-reviewing](pr-review.md#re-review-and-thread-resolution). Replace its
summary in place; do not post another top-level review. Updates require a new
approved preview and put new findings in the summary, preserving old inline
anchors. Failure to update must not create a replacement post.
Thread actions run only after the initial review or summary update is confirmed and the thread
still matches the inventoried snapshot. Reply proposals in the payload are not
sent. Publication never merges the pull request.

Public text must use repository-relative paths or public URLs. It must not
include secret values, local paths (including `~/…`), session ids, hostnames, or
account/billing details. You still read the preview; automated redaction is not
enough.

## Optional automation

Keep the human preview gate. Reasonable additions later:

1. A launcher that opens a Cloud Agent with the instruction template and PR URL
   filled in, then stops.
2. A notifier that sends you `PREVIEW_SHA256` and the summary when `show`
   succeeds.
3. An idempotent job that runs `post` only after an `approval.json` you already
   wrote (safe to retry: a confirmed review id is not posted again).

Do not wire `post` to pull_request webhooks, Greptile credits, or green CI alone.

## Related docs

| Doc | Audience |
|-----|----------|
| [pr-review.md](pr-review.md) | Agent procedure, isolation, ledger, live test |
| [review-rules.md](review-rules.md) | What counts as a finding |
| [eval/review/README.md](../eval/review/README.md) | Offline detection scoring (not publication) |
