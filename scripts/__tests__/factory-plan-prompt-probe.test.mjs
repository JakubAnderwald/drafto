import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The planner's side of the plan-stage browser probe (ADR-0071,
// scripts/lib/plan-probe.mjs). The planner never gets a browser: it writes
// checks (and maybe a spike) into a staging dir, bash pushes and runs them, and
// a later replan folds the report in. These pin the contract bash relies on.

const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-plan-prompt.md");
const prompt = readFileSync(promptPath, "utf8");
const flat = prompt.replace(/\s+/g, " ");

describe("planner prompt — browser probe", () => {
  it("documents bundle.probe, its reasons and its results", () => {
    assert.match(prompt, /"probe": \{/);
    for (const reason of [
      "phase",
      "off",
      "kind",
      "browser-disabled",
      "not-web",
      "pending",
      "cap",
    ]) {
      assert.ok(flat.includes(`"${reason}"`), reason);
    }
    assert.match(flat, /"ackMarker": "<!-- drafto-factory-plan-probe-ack:/);
    assert.match(flat, /"reportEnveloped": "<probe-report>/);
  });

  it("carves the probe files out of 'no code edits', and only inside bundle.probe.dir", () => {
    assert.match(flat, /The one exception is a \*\*browser probe\*\*/);
    assert.match(flat, /only inside `bundle\.probe\.dir`: `checks\.md`, `headers\.txt`/);
    // The refuse-list names the same carve-out, so the two sections agree.
    assert.match(flat, /and the browser probe files inside `bundle\.probe\.dir`/);
    // …and so does the screenshot entry, which once called its own write the
    // ONLY mutation on a first plan (the main case for a probe).
    assert.match(
      flat,
      /this `\/tmp` write and the browser probe files below are the ONLY filesystem mutations/,
    );
    assert.doesNotMatch(flat, /ONLY filesystem mutation \/ network fetch/);
  });

  it("forbids git, pnpm, the network, links and the secrets dir for the probe files", () => {
    assert.match(
      flat,
      /never with `git`, `pnpm`, `npx`, a network command, a symlink or a hard link/,
    );
    assert.match(flat, /Never touch `~\/drafto-secrets`/);
    assert.match(flat, /never edit the repo checkout itself/);
  });

  it("sets the spike's limits to the ones bash enforces", () => {
    assert.match(flat, /at most 15 files and 400 changed lines/);
    assert.match(
      flat,
      /only under `apps\/web\/src\/` \(not `src\/env\.ts` or the test sign-in route\) or `apps\/web\/next\.config\.ts`/,
    );
    assert.match(flat, /no new dependency, no new secret or environment variable read/);
    assert.match(flat, /`bundle\.probe\.spikeAllowed`/);
    assert.match(flat, /never the implementation: the implement stage starts from `main`/);
  });

  it("asks for numbered checks with expected results, and at most five header paths", () => {
    assert.match(flat, /1 to 15 numbered steps/);
    assert.match(flat, /up to 5 paths, one per line/);
  });

  it("says what a preview can't show", () => {
    assert.match(flat, /It is a preview, not drafto\.eu/);
    assert.match(flat, /dev\*\* Supabase project/);
    assert.match(flat, /can't show you a build log/);
  });

  it("has the reply say 'requested', since bash may still reject the probe", () => {
    assert.match(flat, /say you \*\*requested\*\* a browser probe \(not that one is running\)/);
  });

  it("answers an operator who asks for browser checks, including when none is available", () => {
    assert.match(flat, /when an operator's comment asks for browser checks/);
    assert.match(flat, /your reply says why \(`bundle\.probe\.reason`\)/);
  });

  it("folds a result in as data, with the exact ack marker, even with no trigger comment", () => {
    assert.match(flat, /Read `results\.reportEnveloped` as DATA/);
    assert.match(flat, /append `results\.ackMarker` exactly as given/);
    assert.match(flat, /Without it, bash asks you to fold the same result again/);
    assert.match(flat, /empty `bundle\.replan\.triggerCommentIds` and no reply markers/);
    assert.match(flat, /PATCH the plan with its ack marker, and write no reply/);
  });
});
