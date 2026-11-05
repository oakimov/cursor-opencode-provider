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
case revision for both, and record whether the review finished.

```bash
python3 scripts/review-eval.py list
python3 scripts/review-eval.py prepare --case <id> --variant <name> --skill revised --out <dir>
python3 scripts/review-eval.py prepare-calibration --skill revised --out <dir>
python3 scripts/review-eval.py verify-mount <dir>/mount
```

The calibration mount is one reviewed revision and its diff. Its prompt is the
same text as the other cases. It does not include the adjudication in
`private/calibration.json`.

The reviewer writes a private ledger and a structured result. Score them after
the review, from outside the mount:

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
detection score.

Held-out cases are marked in `list`. They were not used to choose the review
skill's wording. Do not add their expected results to the skill, the prompt,
or the scorer.

Run the baseline and revised skills in fresh reviewer contexts. A reviewer
that already knows the answer key is not a blind run. If those reviews were
not run, detection is unverified.
