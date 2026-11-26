import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { feedbackDigest } from "../lib/implement-resume.mjs";
import { DEVICE_REPORT_MARKER, composeDeviceReport } from "../lib/verify-report.mjs";

// ADR-0106 decision 6: the device lane's follow-up comment is posted under the
// operator's gh identity (OWNER) after the card reached In Test. It must read
// as the factory's own output, never as operator feedback: otherwise it would
// roll the card back to In Progress for a revision, or start a replan. Every
// detector keys on the generic `<!-- drafto-factory` prefix, which the
// device-report marker carries, so none needed a change; these tests pin that.

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentPath = join(scriptsDir, "factory-agent.sh");

const extract = (name) =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`;

// <comments> reach bash as data, in $COMMENTS_JSON: a report body holds
// backticks, which bash would run as a command inside a quoted literal.
function bash(fns, body, comments = []) {
  const r = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        ...["support_forward_filter", "gate_support_forwards", ...fns].map(extract),
        body,
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, COMMENTS_JSON: JSON.stringify(comments) } },
  );
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return r.stdout.trim();
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

// A real follow-up body, as verify-report.mjs --kind device writes it.
const DEVICE_BODY = composeDeviceReport({
  sha: SHA,
  pr: 926,
  output: {
    version: 1,
    runId: "874-0123456789ab-20261110T051950Z",
    sha: SHA,
    trigger: "testing",
    platforms: {
      ios: {
        state: "done",
        verdict: "FAIL",
        build: { cached: true, durationS: 300 },
        flows: [
          { name: "ios-all.yaml", status: "FAIL", durationS: 90, failure: "Element not found" },
        ],
      },
    },
  },
  dir: "/runs/874",
  secrets: { devicePassword: "" },
}).body;

const COMMENTS = [
  {
    id: 1,
    body: "<!-- drafto-factory-in-test -->ready",
    createdAt: "2026-11-10T05:00:00Z",
    authorAssociation: "OWNER",
  },
  {
    id: 2,
    body: DEVICE_BODY,
    createdAt: "2026-11-10T07:00:00Z",
    authorAssociation: "OWNER",
  },
  {
    id: 3,
    body: "The button is still misaligned on iOS.",
    createdAt: "2026-11-10T07:30:00Z",
    authorAssociation: "OWNER",
  },
];
const ONLY_DEVICE = [COMMENTS[0], COMMENTS[1]];

describe("the device lane's follow-up comment is factory output, not feedback", () => {
  it("carries the device-report marker, which starts with the generic factory prefix", () => {
    assert.ok(DEVICE_BODY.includes(DEVICE_REPORT_MARKER));
    assert.ok(DEVICE_REPORT_MARKER.startsWith("<!-- drafto-factory"));
    // It reads like feedback otherwise: a FAIL verdict and a failure line.
    assert.match(DEVICE_BODY, /Verdict: FAIL/);
  });

  it("reaches bash unchanged: the backticks in the body are data, not a command", () => {
    assert.ok(DEVICE_BODY.includes("`0123456789ab`"));
    const out = bash([], `printf '%s' "$COMMENTS_JSON" | jq -r '.[1].body'`, COMMENTS);
    assert.equal(out, DEVICE_BODY.trim());
  });

  it("owner_comments_since skips it and keeps the operator's comment", () => {
    const out = bash(
      ["owner_comments_since"],
      `owner_comments_since "$COMMENTS_JSON" "2026-11-10T06:00:00Z" | jq -c '[.[].id]'`,
      COMMENTS,
    );
    assert.equal(out, "[3]");
    // With nothing but the follow-up since the cut-off, nothing is left.
    const none = bash(
      ["owner_comments_since"],
      `owner_comments_since "$COMMENTS_JSON" "2026-11-10T06:00:00Z" | jq -c '[.[].id]'`,
      ONLY_DEVICE,
    );
    assert.equal(none, "[]");
  });

  it("has_actionable_feedback finds nothing when the follow-up is the only new comment", () => {
    const run = (comments) =>
      bash(
        ["owner_comments_since", "is_noise_comment", "has_actionable_feedback"],
        `has_actionable_feedback "$COMMENTS_JSON" "2026-11-10T06:00:00Z" && echo FEEDBACK || echo NONE`,
        comments,
      );
    assert.equal(run(ONLY_DEVICE), "NONE");
    assert.equal(run(COMMENTS), "FEEDBACK");
  });

  it("unacked_owner_comments doesn't count it as a comment to replan for", () => {
    const out = bash(
      ["unacked_owner_comments"],
      `unacked_owner_comments "$COMMENTS_JSON" "2026-11-10T06:00:00Z" '[]'`,
      COMMENTS,
    );
    assert.deepEqual(JSON.parse(out), ["3"]);
  });

  it("implement-resume's feedback digest ignores it", () => {
    assert.equal(feedbackDigest(ONLY_DEVICE), feedbackDigest([COMMENTS[0]]));
    assert.notEqual(feedbackDigest(COMMENTS), feedbackDigest(ONLY_DEVICE));
  });
});
