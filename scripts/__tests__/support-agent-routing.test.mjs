import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Structural guardrails for how support-agent.sh routes progress / lifecycle
// emails (issue #658). Issue #658 was filed from a customer's first email, which
// Zoho never gives a threadId. Its footer said `zoho-thread-id: null`, so
// --comment-sync skipped its "Working on it" / "Fix in review" comments without
// a word, and --state-sync handed Claude an unroutable bundle. Claude improvised
// a noop, and the closed/completed email was lost for good. These tests pin the
// fix: both sync modes resolve the route through `github-sync.mjs issue-route`
// (thread id, or the inbound message id recorded at filing), and an unroutable
// issue is reported instead of skipped silently. No test runs the script itself:
// it needs Zoho OAuth, gh and claude.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "support-agent.sh");
const script = readFileSync(agentPath, "utf8");

function section(startMarker, endMarker) {
  const start = script.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = script.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  return script.slice(start, end);
}

const commentSync = section('if [[ "$COMMENT_SYNC" -eq 1 ]]; then', "# ── --state-sync sweep");
const stateSync = section('if [[ "$STATE_SYNC" -eq 1 ]]; then', "# ── Cheap pre-check");
const perThreadLoop = section("# ── Per-thread loop", "    customer-reply)");
const filedIssue = section("    filed-issue)", "    customer-reply)");

const ISSUE_ROUTE_CALL =
  /printf '%s' "\$ISSUE_BODY" \| node "\$SCRIPT_DIR\/lib\/github-sync\.mjs" issue-route \\\n\s+"\$ISSUE_NUMBER" --body-file - --state-file "\$STATE_FILE"/;

describe("support-agent.sh syntax", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("stays bash 3.2-compatible (launchd runs /bin/bash 3.2 on macOS)", () => {
    assert.doesNotMatch(script, /\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/, "no ${VAR,,} lower-casing");
    assert.doesNotMatch(script, /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^\}/, "no ${VAR^^} upper-casing");
    assert.doesNotMatch(script, /\bdeclare -A\b/, "no associative arrays");
    assert.doesNotMatch(script, /\b(?:mapfile|readarray)\b/, "no mapfile / readarray");
  });
});

describe("--comment-sync routing", () => {
  it("resolves the route via github-sync issue-route, piping in the listed body", () => {
    assert.match(commentSync, ISSUE_ROUTE_CALL);
  });

  it("no longer reads the thread id straight from state-cli", () => {
    assert.doesNotMatch(commentSync, /get-issue-zoho-thread-id/);
  });

  it("does not silently skip an issue just because it has no thread id", () => {
    assert.doesNotMatch(commentSync, /if \[\[ -z "\$THREAD_ID" \]\]; then\s+continue/);
  });

  it("skips only unroutable issues, and logs them", () => {
    assert.match(
      commentSync,
      /if \[\[ "\$\(echo "\$ROUTE_JSON" \| jq -r '\.routable'\)" != "true" \]\]; then\s+UNROUTED_ISSUES="\$UNROUTED_ISSUES #\$ISSUE_NUMBER"\s+continue/,
    );
    assert.match(
      commentSync,
      /if \[\[ -n "\$UNROUTED_ISSUES" \]\]; then\s+UNROUTED_LINE="Comment-sync: no Zoho route \(no thread id, no message id \+ reporter email\) for issue\(s\)\$UNROUTED_ISSUES; skipping"/,
    );
  });

  it("logs the unroutable set once per daily log file, not every tick", () => {
    assert.match(
      commentSync,
      /if ! grep -qF -- "\$UNROUTED_LINE" "\$LOG_FILE" 2>\/dev\/null; then\s+log "\$UNROUTED_LINE"/,
    );
  });

  it("starts from createdAt only for a route recorded at filing; otherwise bootstraps the cursor", () => {
    // An issue made routable after the fact (footer fallback, linked-reply
    // upgrade, rebuilt state) must not get months of backlog emailed.
    assert.match(
      commentSync,
      /FILED_MESSAGE_ID=\$\(jq -r --arg n "\$ISSUE_NUMBER" '\.issues\[\$n\]\.zohoMessageId \/\/ empty'/,
    );
    assert.match(
      commentSync,
      /if \[\[ -z "\$CURSOR" && -n "\$FILED_MESSAGE_ID" \]\]; then\s+CURSOR=\$\(echo "\$ISSUE_ENTRY" \| jq -r '\.createdAt'\)/,
    );
    const start = commentSync.indexOf('elif [[ -z "$CURSOR" ]]; then');
    assert.ok(start !== -1, "bootstrap branch present");
    const branch = commentSync.slice(start, commentSync.indexOf("      continue\n", start));
    assert.match(branch, /state-cli\.mjs" set-issue-cursor "\$ISSUE_NUMBER" "\$BOOTSTRAP_AT"/);
    assert.doesNotMatch(branch, /list-new-comments|run-claude/);
    const bootstrap = commentSync.indexOf("BOOTSTRAP_AT=");
    const listComments = commentSync.indexOf("list-new-comments");
    assert.ok(bootstrap < listComments, "bootstrap runs before any comment is fetched");
  });

  it("passes the route into the github_comment_batch bundle", () => {
    assert.match(commentSync, /--argjson route "\$ROUTE_JSON"/);
    assert.match(commentSync, /kind: "github_comment_batch"[\s\S]*zohoRoute: \$route/);
  });
});

describe("--state-sync routing", () => {
  it("resolves the route via github-sync issue-route before state-change-info", () => {
    assert.match(stateSync, ISSUE_ROUTE_CALL);
    const route = stateSync.search(ISSUE_ROUTE_CALL);
    const info = stateSync.indexOf('github-sync.mjs" state-change-info');
    assert.ok(info !== -1, "state-change-info still enriches routable transitions");
    assert.ok(route < info, "the route is resolved first, so unroutable issues cost no gh calls");
  });

  it("no longer routes on the footer-only zoho_thread_id from state-change-info", () => {
    assert.doesNotMatch(stateSync, /\.zoho_thread_id \/\/ empty/);
  });

  it("handles an unroutable issue deterministically: WARNING, advance state, no Claude", () => {
    const start = stateSync.indexOf(
      `if [[ "$(echo "$ROUTE_JSON" | jq -r '.routable')" != "true" ]]; then`,
    );
    assert.ok(start !== -1, "unroutable branch present");
    const branch = stateSync.slice(start, stateSync.indexOf("      continue\n", start));
    assert.match(branch, /log "WARNING: State-sync: issue #\$ISSUE_NUMBER has no Zoho route/);
    assert.match(branch, /state-cli\.mjs" set-issue-state "\$ISSUE_NUMBER"/);
    assert.doesNotMatch(branch, /run-claude/);
    assert.doesNotMatch(branch, /build-bundle/);
  });

  it("pipes the listed body into state-change-info (no extra gh issue view)", () => {
    assert.match(
      stateSync,
      /printf '%s' "\$ISSUE_BODY" \| node "\$SCRIPT_DIR\/lib\/github-sync\.mjs" state-change-info \\\n\s+"\$ISSUE_NUMBER" --bot-user "\$SUPPORT_BOT_GH_USER" --body-file -/,
    );
  });

  it("passes the route into the github_state_change bundle", () => {
    assert.match(stateSync, /--argjson route "\$ROUTE_JSON"/);
    assert.match(stateSync, /kind: "github_state_change"[\s\S]*zohoRoute: \$route/);
  });
});

describe("filed-issue: route persisted at filing time", () => {
  it("captures the inbound subject from the list-pending entry", () => {
    assert.match(perThreadLoop, /SUBJECT=\$\(echo "\$ENTRY" \| jq -r '\.subject \/\/ empty'\)/);
  });

  it("passes --message-id and --subject to record-filed-issue", () => {
    assert.match(
      filedIssue,
      /RECORD_ARGS=\(record-filed-issue "\$ISSUE_NUM" "\$SENDER" "\$\{THREAD_ID:-\}"\)/,
    );
    assert.match(filedIssue, /RECORD_ARGS\+=\(--message-id "\$MSG_ID"\)/);
    assert.match(filedIssue, /RECORD_ARGS\+=\(--subject "\$SUBJECT"\)/);
    assert.match(filedIssue, /state-cli\.mjs" "\$\{RECORD_ARGS\[@\]\}"/);
  });

  it("no longer re-reads the LLM-written footer for an ack thread id", () => {
    assert.doesNotMatch(filedIssue, /gh issue view/);
    assert.doesNotMatch(filedIssue, /parse-issue-footer\.mjs/);
    assert.doesNotMatch(filedIssue, /ACK_TID/);
  });

  it("warns only when neither a thread id nor a message id was recorded", () => {
    assert.match(
      filedIssue,
      /if \[\[ -z "\$\{THREAD_ID:-\}" && -z "\$MSG_ID" \]\]; then\s+log "WARNING: issue \$ISSUE_NUM was filed with neither a Zoho thread id nor a message id/,
    );
  });
});

describe("inbound: a linked customer reply upgrades the issue to thread routing", () => {
  it("records the reply's thread id when state has none (live --auto-classify only)", () => {
    assert.match(
      perThreadLoop,
      /if \[\[ "\$AUTO_CLASSIFY" -eq 1 && -n "\$THREAD_ID" && "\$LINKED_ISSUE" =~ \^\[0-9\]\+\$ \]\]; then/,
    );
    assert.match(perThreadLoop, /get-issue-zoho-thread-id "\$LINKED_ISSUE"/);
    assert.match(perThreadLoop, /set-issue-field "\$LINKED_ISSUE" zohoThreadId "\$THREAD_ID"/);
  });

  it("writes only when the lookup succeeded, never on a failed read", () => {
    assert.match(
      perThreadLoop,
      /if KNOWN_THREAD_ID=\$\(node "\$SCRIPT_DIR\/lib\/state-cli\.mjs" get-issue-zoho-thread-id "\$LINKED_ISSUE"/,
    );
    assert.doesNotMatch(
      perThreadLoop,
      /get-issue-zoho-thread-id "\$LINKED_ISSUE"[^)]*\|\| echo ""/,
    );
    assert.match(
      perThreadLoop,
      /WARNING: get-issue-zoho-thread-id failed for issue #\$LINKED_ISSUE/,
    );
  });

  it("runs after find-linked-issue, so the linkage it reads is fresh", () => {
    const find = perThreadLoop.indexOf("find-linked-issue");
    const upgrade = perThreadLoop.indexOf('set-issue-field "$LINKED_ISSUE" zohoThreadId');
    assert.ok(find !== -1 && upgrade !== -1);
    assert.ok(find < upgrade);
  });
});
