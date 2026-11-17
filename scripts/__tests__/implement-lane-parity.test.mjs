// A detached --implement run (ADR-0085) must make exactly the claude call the
// synchronous path makes: same script, same flags, same per-call env, same
// input, same cwd. This pins implement-lane.mjs's buildImplementArgv /
// buildImplementEnv to the synchronous invocation in factory-agent.sh, and
// implement_lane_start's spec to the same bash variables. The supervisor test
// checks the call claude actually receives.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUN_CLAUDE,
  SESSION_FLAGS,
  buildImplementArgv,
  buildImplementEnv,
} from "../lib/implement-lane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(HERE, "..", "factory-agent.sh"), "utf8");
const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// The synchronous call, from `( cd "$WT_PATH" && …` to its closing `)`.
const SYNC = (() => {
  const m = script.match(
    /\n {4}\( cd "\$WT_PATH" && (CLAUDE_CALL_TIMEOUT_SEC=[^\n]*?) \\\n\s*node "\$SCRIPT_DIR\/lib\/run-claude\.mjs" -p "\$CLAUDE_INPUT" ([^\n]*?) \\\n\s*([^\n]*?) \) >"\$CLAUDE_OUTPUT_FILE"/,
  );
  assert.ok(m, "the synchronous --implement call was not found");
  return { env: m[1], flags: `${m[2]} ${m[3]}` };
})();

const words = (s) => s.trim().split(/\s+/);

describe("detached implement = the synchronous call (parity)", () => {
  it("there is exactly one synchronous implement call", () => {
    // The detached start adds no second one: it builds its argv in node.
    assert.equal(
      script.split(
        'run-claude.mjs" -p "$CLAUDE_INPUT" --dangerously-skip-permissions --effort "$FACTORY_EFFORT"',
      ).length - 1,
      1,
    );
  });

  for (const mode of ["fresh", "resume"]) {
    it(`flags: buildImplementArgv({mode: "${mode}"}) is the synchronous call's argv`, () => {
      const sync = words(SYNC.flags).map((w) =>
        w === '"$FACTORY_EFFORT"'
          ? "ultracode"
          : w === '"$IMPL_SESSION_FLAG"'
            ? SESSION_FLAGS[mode]
            : w === '"$IMPL_SESSION_ID"'
              ? SID
              : w,
      );
      assert.deepEqual(buildImplementArgv({ effort: "ultracode", mode, sessionId: SID }), sync);
    });
  }

  it("the session flags are the ones implement_resume_decide sets", () => {
    const decide = script.match(/\nimplement_resume_decide\(\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(decide, /IMPL_SESSION_FLAG="--session-id"/);
    assert.match(decide, /IMPL_SESSION_FLAG="--resume"/);
    assert.deepEqual(SESSION_FLAGS, { fresh: "--session-id", resume: "--resume" });
  });

  it("env: the same three per-call variables, from the same knobs", () => {
    const sync = Object.fromEntries(
      words(SYNC.env).map((w) => {
        const [k, v] = w.split("=");
        return [k, v];
      }),
    );
    assert.deepEqual(sync, {
      CLAUDE_CALL_TIMEOUT_SEC: '"$IMPLEMENT_TIMEOUT_SEC"',
      CLAUDE_CALL_KILL_GRACE_SEC: '"$FACTORY_IMPLEMENT_TERM_GRACE_SEC"',
      CLAUDE_CALL_KILL_GROUP: "1",
    });
    const env = buildImplementEnv({}, { timeoutSec: "T", termGraceSec: "G" });
    assert.deepEqual(env, {
      CLAUDE_CALL_TIMEOUT_SEC: "T",
      CLAUDE_CALL_KILL_GRACE_SEC: "G",
      CLAUDE_CALL_KILL_GROUP: "1",
    });
  });

  it("the start passes those same knobs, the claude input untouched, and the worktree", () => {
    const start = script.match(/\nimplement_lane_start\(\) \{[\s\S]*?\n\}\n/)[0];
    for (const re of [
      /--arg effort "\$FACTORY_EFFORT"/,
      /--arg sessionId "\$IMPL_SESSION_ID"/,
      /--arg timeoutSec "\$IMPLEMENT_TIMEOUT_SEC"/,
      /--arg termGraceSec "\$FACTORY_IMPLEMENT_TERM_GRACE_SEC"/,
      /--arg worktree "\$WT_PATH"/,
      /printf '%s' "\$CLAUDE_INPUT" >"\$input"/,
      /\[\[ "\$IMPL_SESSION_FLAG" == "--resume" \]\] && mode="resume"/,
    ]) {
      assert.match(start, re);
    }
  });

  it("the supervisor runs the same run-claude.mjs, in the worktree", () => {
    assert.equal(RUN_CLAUDE, resolve(HERE, "..", "lib", "run-claude.mjs"));
    const lane = readFileSync(resolve(HERE, "..", "lib", "implement-lane.mjs"), "utf8");
    assert.match(
      lane,
      /spawnImpl\(meta\.node, \[meta\.runClaude, "-p", input, \.\.\.meta\.argv\], \{\n\s*cwd: meta\.worktree,/,
    );
  });
});
