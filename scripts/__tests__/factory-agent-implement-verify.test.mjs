// The false-success guard in --implement.
//
// An agent whose worktree does not descend from the PR head gets its push
// rejected, and used to still report action=implemented. Bash believed it,
// advanced the card to In Review, and set lastFeedbackAt=now — which marks
// every reporter comment consumed, so the change request could never be
// replayed. Nothing surfaced the loss. See ADR-0033.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

function sliceBetween(startNeedle, endNeedle, label) {
  const start = script.indexOf(startNeedle);
  assert.ok(start !== -1, `could not find the start of ${label}`);
  const end = script.indexOf(endNeedle, start);
  assert.ok(end !== -1, `could not find the end of ${label}`);
  return script.slice(start, end);
}

const implementedArm = sliceBetween("      implemented)", "      noop)", "the implemented arm");
const noopArm = sliceBetween(
  '      noop)\n        if [[ "$IS_REVISION"',
  "      blocked)",
  "the noop arm",
);

describe("factory-agent.sh --implement verification", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("reads the PR head OID without disturbing find_prior_pr's shape", () => {
    assert.match(script, /pr_head_oid\(\) \{/);
    assert.match(script, /--json headRefOid --jq '\.headRefOid'/);
    // find_prior_pr feeds the implement bundle, whose shape factory-bundle
    // tests pin — it must keep returning exactly these four fields.
    assert.match(
      script,
      /\{ number: \.number, url: \.url, headRef: \.headRefName, state: \.state \}/,
    );
  });

  it("captures the head after the install and before invoking claude", () => {
    const block = sliceBetween(
      'run_pnpm_install "$WT_PATH"',
      "run-claude.mjs",
      "the implement invocation",
    );
    assert.match(block, /PRE_HEAD_OID=\$\(pr_head_oid/);
  });

  it("skips the guard on a fresh implementation (no prior PR to compare)", () => {
    assert.match(
      script,
      /PRE_HEAD_OID=""\n\s*PRE_HEAD_KNOWN=1\n\s*if \[\[ "\$PRIOR_PR" != "null" \]\]; then/,
    );
  });

  it("compares the head before running the parity post-check", () => {
    const guardAt = implementedArm.indexOf("POST_HEAD_OID");
    const parityAt = implementedArm.indexOf("parity_violation");
    assert.ok(guardAt !== -1, "the implemented arm should compare head OIDs");
    assert.ok(parityAt !== -1, "the implemented arm should still run the parity check");
    assert.ok(guardAt < parityAt, "no point diffing a PR that never moved");
  });

  it("treats an unchanged head as a failed attempt, not a success", () => {
    const mismatch = sliceBetween(
      'if [[ "$POST_HEAD_OID" == "$PRE_HEAD_OID" ]]; then',
      "        # Parity / phase post-check",
      "the head-unchanged arm",
    );
    assert.match(mismatch, /factory:bump-attempts/);
    assert.match(mismatch, /continue/);
    assert.doesNotMatch(
      mismatch,
      /lastFeedbackAt/,
      "the reporter's feedback must stay unconsumed so the next attempt still sees it",
    );
    assert.doesNotMatch(
      mismatch,
      /reset-attempts/,
      "resetting attempts here would loop forever instead of parking in Blocked",
    );
    assert.doesNotMatch(mismatch, /"In Review"/, "the card must not advance on a false success");
  });

  it("fails closed when the head OID cannot be read", () => {
    const unknown = sliceBetween(
      'if [[ -z "$POST_HEAD_OID" ]]; then',
      'if [[ "$POST_HEAD_OID" == "$PRE_HEAD_OID" ]]; then',
      "the unreadable-OID arm",
    );
    assert.match(unknown, /factory:bump-attempts/);
    assert.match(unknown, /continue/);
    assert.doesNotMatch(unknown, /lastFeedbackAt/);
  });

  it("comments once, with a marker the feedback filter will skip", () => {
    assert.match(implementedArm, /drafto-factory-head-unchanged/);
    // owner_comments_since drops bodies matching "<!-- drafto-factory", so the
    // marker must carry that prefix or the factory's own comment comes back as
    // reporter feedback on the next tick.
    assert.match(script, /<!-- drafto-factory-head-unchanged -->/);
    assert.match(implementedArm, /contains\("drafto-factory-head-unchanged"\)/);
  });

  it("catches work committed but not landed on a noop revision", () => {
    // The OID is legitimately unchanged for a genuine noop, so the local HEAD
    // is the only thing that separates "nothing to do" from "push failed".
    // Slice the guard itself: the surrounding noop arm contains an unrelated
    // bump-attempts call, so asserting against the whole arm passes vacuously.
    const guard = sliceBetween(
      'LOCAL_HEAD=$(git -C "$WT_PATH" rev-parse HEAD',
      "# The feedback needed no code change",
      "the committed-but-unlanded guard",
    );
    assert.match(guard, /"\$LOCAL_HEAD" != "\$PRE_HEAD_OID"/);
    assert.match(guard, /factory:bump-attempts/);
    assert.match(guard, /continue/);
    // Only "ahead of / diverged from" means unlanded work. A worktree merely
    // behind the PR head (someone else pushed) must not be treated as failure.
    assert.match(guard, /merge-base --is-ancestor "\$LOCAL_HEAD" "\$PRE_HEAD_OID"/);
    // A dirty-tree check would false-positive: run_pnpm_install can leave
    // pnpm-lock.yaml modified.
    assert.doesNotMatch(noopArm, /status --porcelain/);
  });

  it("distinguishes 'nothing to verify' from 'could not find out'", () => {
    // Collapsing both into an empty PRE_HEAD_OID would skip the guard entirely
    // on a revision run whose pre-run `gh pr view` failed — the same silent
    // feedback loss the guard exists to prevent.
    assert.match(script, /PRE_HEAD_KNOWN=1/);
    assert.match(script, /PRE_HEAD_KNOWN=0/);
    const capture = sliceBetween('PRE_HEAD_OID=""', "# Invoke claude", "the head capture");
    assert.match(capture, /if \[\[ -z "\$PRE_HEAD_OID" \]\]; then\n\s*PRE_HEAD_KNOWN=0/);
  });

  for (const [arm, armText] of [
    ["implemented", implementedArm],
    ["noop", noopArm],
  ]) {
    it(`fails closed in the ${arm} arm when the pre-run head is unknown`, () => {
      // Slice the guard out of the arm itself — searching the whole script
      // would find the other arm's copy and span unrelated code.
      // Anchor the closing `fi` to its own line — a bare indexOf("fi") matches
      // inside `--state-file`.
      const m = armText.match(/if \[\[ "\$PRE_HEAD_KNOWN" -eq 0 \]\]; then[\s\S]*?\n[ \t]*fi\n/);
      assert.ok(m, `${arm} arm should check the PRE_HEAD_KNOWN flag`);
      const guard = m[0];
      assert.match(guard, /factory:bump-attempts/);
      assert.match(guard, /continue/);
      assert.doesNotMatch(guard, /lastFeedbackAt/);
      assert.doesNotMatch(guard, /transition_status/);
    });
  }

  it("leaves the legitimate noop paths advancing as before", () => {
    assert.match(noopArm, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Test"/);
    assert.match(noopArm, /lastFeedbackAt "\$NOW_ISO"/);
  });
});

describe("factory-prompt.md stops instructing the false claim", () => {
  const prompt = readFileSync(resolve(HERE, "..", "factory-prompt.md"), "utf8");

  it("no longer tells the agent to force-update the PR and claim success", () => {
    assert.doesNotMatch(prompt, /force-update it via a\s*\n?\s*new commit \+ push/);
  });

  it("tells the agent to stop and block when a push is rejected", () => {
    assert.match(prompt, /If `git push` is rejected, STOP/);
    assert.match(prompt, /push rejected:/);
  });

  it("requires a head check before reporting success", () => {
    assert.match(prompt, /headRefOid/);
    assert.match(prompt, /Verify before you report/);
  });
});
