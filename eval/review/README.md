# Review evaluation

This directory is a manual check of the review procedure. `bun test` runs the
fixtures and the scorer. It does not start a Cloud Agent, call a model, or
publish a review. A passing suite does not mean the procedure finds defects.

## What a fresh reviewer receives

`scripts/review-eval.py prepare` writes `<out>/mount/` and `<out>/meta.json`.
Give the reviewer only `mount/`: the case checkout, `diff.patch`, `PROMPT.txt`,
and `instructions/`. `meta.json` stays outside that directory. The answer key
in `private/` is not copied. One variant is applied, so the other variant is
not in the mount.

`prepare --skill baseline` copies `eval/review/baseline/`, the procedure at
harness commit `eval/review/baseline/SOURCE_SHA`. `prepare --skill revised`
copies the current skill and the two guides. Use the same model, runtime, and
case revision for both, and record whether the review finished. Both receive
the same offline adapter in `PROMPT.txt`, policy context, and ledger validator.
`supportSha256` in the metadata covers that shared adapter and support files;
`skillSha256` covers the selected instruction snapshot.

```bash
python3 scripts/review-eval.py list
python3 scripts/review-eval.py prepare --case <id> --variant <name> --skill revised --out <dir>
python3 scripts/review-eval.py verify-mount <dir>/mount
```

The calibration mount is one reviewed revision and its diff. Its prompt is the
same text as the other cases. It does not include the adjudication in
`private/calibration.json`. This manual integration needs the two pinned commit
objects from that file, which a shallow CI checkout does not contain. Fetch
them explicitly before preparing it; the preparation command performs no fetch
and refuses missing objects before creating its output directory:

```bash
git fetch --no-tags origin fcf331e8ceb3a169f6f72205e5df262991bf9e1f f122fe36afe85500ee0164ec2a24ebdfd23b13dc
python3 scripts/review-eval.py prepare-calibration --skill revised --out <dir>
```

Unit tests exercise the archive/diff path with a local two-commit repository,
including a shallow copy with a missing base and recovery after fetching it.
They do not depend on unrelated PR objects or perform a real calibration run.

The reviewer starts at the mount root and reviews `checkout/`. Policy files
live at their production paths outside `checkout/`; the three selected review
guides live under `instructions/`. The adapter replaces production PR binding,
CI lookups, isolated PR fetching, live authentication, and publication with an
offline review. It requires applicable local tests and records the omitted
production gates as limitations. It does not relax those gates for real PRs.
The mount includes `scripts/review-ledger.py`, so completion checks need no
access to its parent. Current harness incident lessons are withheld because
they can contain later adjudication of the calibration subject. The reviewer
can read lessons in the reviewed checkout itself when present.

The reviewer writes `ledger.json` and `review.json` at the mount root, using
`revision: "local"` and `head: "local"` respectively. The adapter describes the
local result fields. This result is for scoring, not publication. Run the
first two commands inside the mount. Then score from outside, passing the
reviewer's saved files:

```bash
python3 scripts/review-ledger.py check ledger.json
python3 scripts/review-ledger.py compare ledger.json review.json
python3 scripts/review-eval.py score --case <id> --variant <name> --review review.json --ledger ledger.json
```

## How a result is read

A defect counts as detected when a finding names its file and states the
causal groups in the answer key. Wording and titles are not compared. A
location without that causal account is `partial`, and the defect stays
`missed`. A finding that matches a non-defect or a defect the fixed variant
removed is a false positive. Any other finding is `unadjudicated`; it is not
automatically a false positive. `overbroad` means the finding matched a real
defect and also a non-defect, so the claim needs narrower wording.

The ledger fields say whether the two passes were recorded. They are not a
detection score. Both snapshots use this same completion format; the comparison
measures their review instructions within the shared offline adapter, rather
than an unmodified production workflow.

Ownership cases check that a review follows owned work past the call that
started it. One case has two defective variants and two controls: a correct
implementation that settles what it owns, and one that explicitly hands work to
an independent manager under its contract. A finding against either control
scores as a false positive, but reproduce it before accepting that label: a
control can itself leak, and the scorer cannot tell a reviewer's error from a
broken control. Fix such a control and review it again with fresh reviewers.
`bun test` runs each variant's real orchestration with
acknowledged ordering and records liveness, existence, and writability after
the owner returns; those fixture checks are not detection results.

Held-out cases are marked in `list`. They were not used to choose the review
skill's wording. Do not add their expected results to the skill, the prompt,
or the scorer.

Run the baseline and revised skills in fresh reviewer contexts. A reviewer
that already knows the answer key is not a blind run. If those reviews were
not run, detection is unverified.
