#!/usr/bin/env node
// Drive a Drafto Factory issue from an interactive Claude Code session
// (ADR-0090, docs/features/interactive-driving.md, the /drive-issue skill).
//
// The factory (scripts/factory-agent.sh on the Mac mini) and an interactive
// session can both work a card, one at a time. The `driver:interactive` label
// says a session owns the card: every factory mode skips it, as it skips
// `factory-pause`. Removing the label (`release`) hands the card back, in any
// column. Because a session leaves the same artifacts the factory does (plan
// comment, factory/issue-<n> branch, PR marker, scenario markers, board
// column + status:* label), the factory carries on from wherever the card is.
//
// Every comment this script posts is a session log entry:
//
//   🧑‍💻 **Interactive session · <step heading>**
//   <body>
//   <!-- drafto-factory-session:<step>[:<key>] -->
//
// The marker sits in the `<!-- drafto-factory` family that the factory's
// feedback sweeps never read as operator feedback, so a handed-back card's log
// can't trigger a replan or a revision.
//
// Commands (issue number first; --json prints the result as JSON):
//   claim <n> [--force] [--resume]      add driver:interactive, put the card on
//                                       the board (Ready) if needed, log it.
//                                       Refuses a card in Planning, In Progress,
//                                       In Review, Testing or Approved without
//                                       --force (a factory run may be live), and
//                                       a card already claimed without --resume.
//   status <n>                          column, owner, PR, plan, recent log.
//   spec <n>                            the factory's spec gate (exit 1 on a gap).
//   move <n> <Status> --note <t>        board column + status:* label, logged.
//   log <n> --step <s> (--body <t> | --body-file <f|->) [--key <k>]
//                                       one log entry; with --key, posted once.
//   plan <n> --body-file <f|->          post the plan comment (factory format),
//       [--note <t>] [--ack <ids>]      or edit it in place and log a replan.
//       [--force]                       Keeps the factory's ack markers; --ack
//                                       adds replan-ack markers for operator
//                                       comments this replan answered.
//   scenario <n> --sha <head> --body-file <f|->
//                                       post the In Test scenario with the
//                                       factory's markers (edited in place per
//                                       head SHA).
//   parity <n> [--pr <p>] [--base <ref>]
//                                       the factory's parity check on the PR's
//                                       diff, or on the local branch vs base.
//   approve-migration <n> [--pr <p>]    after the operator's explicit yes: add
//                                       migration-approved and log the PR's SQL
//                                       hash (gates and release check it).
//   gates <n> [--pr <p>] [--log]        the --release pre-merge checks, all on
//                                       one PR head (exit 1 when any fails).
//   merge <n> [--pr <p>]                gates --log, then squash-merge pinned to
//                                       the head the gates passed.
//   hosted-config <n> [--pr <p>]        the hosted-config gate alone, before a
//                                       pre-merge beta (exit 1 unless ok).
//   release <n> [--to <Status>] --note <t> [--force]
//                                       hand the card back to the factory (in
//                                       its current column without --to). The
//                                       column must fit; --force skips only the
//                                       plan / open-PR requirement. Handing a
//                                       card past a human gate needs that
//                                       gate's approval logged first. Logs the
//                                       handback, then removes the label (and
//                                       withdraws the entry if that fails).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FACTORY_PLAN_MARKER,
  effectiveParityOverride,
  parsePlanSize,
  parseSpec,
} from "./lib/factory-bundle.mjs";
import * as projectLib from "./lib/factory-project.mjs";
import {
  ALL_STATUS_LABELS,
  STATUS_LABELS,
  migrationViolation,
  parityViolation,
  specMissingSection,
  statusLabelFor,
} from "./lib/issue-gates.mjs";

export const REPO = "JakubAnderwald/drafto";
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REPO_ROOT = dirname(SCRIPTS_DIR);
export const DRIVER_LABEL = "driver:interactive";
export const SESSION_MARKER_PREFIX = "drafto-factory-session:";
export const PR_MARKER = "<!-- drafto-factory-pr -->";
export const SCENARIO_MARKERS = Object.freeze([
  "<!-- drafto-factory-in-test -->",
  "<!-- drafto-factory-test-scenario -->",
]);
export const MIGRATION_LABEL = "migration-approved";

// Columns where a factory run may be in flight: a Planning call, a detached
// implement run (ADR-0085), a --watch fix pass pushing to the PR, a
// verification lane (ADR-0053) or a --release merge and beta dispatch.
export const RISKY_CLAIM_COLUMNS = Object.freeze([
  "Planning",
  "In Progress",
  "In Review",
  "Testing",
  "Approved",
]);

// Every log step a session posts, with its heading. The /drive-issue skill and
// docs/features/interactive-driving.md list the same steps (a test checks).
export const LOG_STEPS = Object.freeze({
  claim: "Claimed",
  spec: "Spec check",
  plan: "Plan",
  replan: "Plan revised",
  "plan-approved": "Plan approved",
  "implement-start": "Implementation started",
  tests: "Test results",
  "code-review": "Code review",
  "pr-opened": "PR opened",
  "ci-green": "CI and review threads green",
  scenario: "Test scenario",
  "verify-report": "Verification report",
  "beta-dispatched": "Pre-merge betas",
  "handoff-to-you": "Ready for your test",
  revision: "Revision",
  approved: "Approved for merge",
  "migration-approved": "Migration approved",
  gates: "Pre-merge gates",
  merged: "Merged",
  "beta-released": "Post-merge betas",
  blocked: "Blocked",
  handback: "Handed back to the factory",
  move: "Moved",
  note: "Note",
});

// The plan sections the factory's plan structure requires
// (scripts/factory-plan-prompt.md § Plan structure). Proposed split is
// optional (L/XL only).
export const PLAN_SECTIONS = Object.freeze([
  "Approach",
  "Confidence",
  "Size",
  "Files to touch",
  "Risks",
  "Parity checklist",
  "Tests",
  "Estimated affected platforms",
]);

// What the factory does next with a card handed back in each column.
export const HANDBACK_NEXT = Object.freeze({
  Backlog: "nothing until you drag it to Ready.",
  Ready: "--plan runs the spec gate and writes a plan.",
  "Plan Review":
    "it waits for you to drag the card to In Progress (your comments trigger a replan).",
  "In Progress": "--implement builds the approved plan on factory/issue-<n>.",
  "In Review": "--watch fixes CI and review threads, runs its code review, then hands the card on.",
  Testing: "the verification lane runs the scenario and posts its report.",
  "In Test":
    "it waits for you to test and drag the card to Approved (actionable comments trigger a revision).",
  Approved: "--release runs its merge gates, squash-merges and dispatches the betas.",
  Released: "nothing (the card is shipped).",
  Done: "nothing (the card is closed out).",
  Blocked: "nothing until you move it out of Blocked.",
});

const PLAN_REQUIRED_COLUMNS = new Set([
  "In Progress",
  "In Review",
  "Testing",
  "In Test",
  "Approved",
]);
const PR_REQUIRED_COLUMNS = new Set(["In Review", "Testing", "In Test", "Approved"]);
const BOARD_COLUMNS = new Set(["Backlog", ...Object.keys(STATUS_LABELS)]);

// The board's columns in flow order (Blocked sits outside it).
export const COLUMN_ORDER = Object.freeze([
  "Backlog",
  "Ready",
  "Planning",
  "Plan Review",
  "In Progress",
  "In Review",
  "Testing",
  "In Test",
  "Approved",
  "Released",
  "Done",
]);

export class DriveError extends Error {}

export const branchFor = (issue) => `factory/issue-${issue}`;

// ── Pure helpers ────────────────────────────────────────────────────────────

export function sessionMarker(step, key = "") {
  return `<!-- ${SESSION_MARKER_PREFIX}${step}${key ? `:${key}` : ""} -->`;
}

export function renderLogComment({ step, body = "", key = "", heading }) {
  if (!Object.hasOwn(LOG_STEPS, step)) throw new DriveError(`unknown log step "${step}"`);
  const title = heading || LOG_STEPS[step];
  const text = String(body).trim();
  return `🧑‍💻 **Interactive session · ${title}**\n\n${text ? `${text}\n\n` : ""}${sessionMarker(step, key)}\n`;
}

// A comment the repo owner posted (the factory and a session both post as
// OWNER) that carries `marker` on a line of its own.
export function ownerCommentWithMarker(comments, marker) {
  const hits = (comments ?? []).filter(
    (c) =>
      c?.authorAssociation === "OWNER" &&
      typeof c.body === "string" &&
      c.body.split("\n").some((line) => line.trim() === marker),
  );
  return hits.length ? hits[hits.length - 1] : null;
}

// The OWNER comments carrying a session marker for `step` (any key), in order.
export function sessionEntries(comments, step) {
  const marker = `<!-- ${SESSION_MARKER_PREFIX}${step}`;
  return (comments ?? []).filter(
    (c) =>
      c?.authorAssociation === "OWNER" &&
      typeof c.body === "string" &&
      c.body.split("\n").some((l) => {
        const t = l.trim();
        return t.startsWith(`${marker} -->`) || t.startsWith(`${marker}:`);
      }),
  );
}

// Index of the newest comment carrying any of `steps`, or -1.
export function lastEntryIndex(comments, steps) {
  const want = new Set(steps.flatMap((st) => sessionEntries(comments, st)));
  let at = -1;
  (comments ?? []).forEach((c, i) => {
    if (want.has(c)) at = i;
  });
  return at;
}

// The session's newest migration approval for PR `prNumber`: {hash, comment}
// or null. Keys are pr<P>-<hash>-<stamp>, so a re-approval always posts anew
// and an approval for another PR on the same issue never counts.
export function latestMigrationApproval(comments, prNumber) {
  const re = new RegExp(
    `<!-- ${SESSION_MARKER_PREFIX}migration-approved:pr${prNumber}-([0-9a-f]+)-[0-9a-z]+ -->`,
  );
  let found = null;
  for (const c of sessionEntries(comments, "migration-approved")) {
    const m = re.exec(c.body);
    if (m) found = { hash: m[1], comment: c };
  }
  return found;
}

// The factory's plan comment: an OWNER comment whose body starts with the plan
// marker (plan_comment_jq in factory-agent.sh). The newest one wins.
export function planCommentOf(comments) {
  const plans = (comments ?? []).filter(
    (c) =>
      c?.authorAssociation === "OWNER" &&
      typeof c.body === "string" &&
      c.body.trimStart().startsWith(FACTORY_PLAN_MARKER),
  );
  return plans.length ? plans[plans.length - 1] : null;
}

// The ack markers the factory keeps in a plan body: one per operator comment a
// replan answered (`replan-ack:<commentId>`, read by unacked_owner_comments)
// and one per folded-in browser probe round (`plan-probe-ack:<probeId>`).
// Dropping one makes the factory replan again on feedback already handled.
const PLAN_ACK_RE = /<!--\s*drafto-factory-(?:replan-ack|plan-probe-ack):[^\s>]+\s*-->/g;

export function planAckMarkers(body) {
  return [...new Set(String(body ?? "").match(PLAN_ACK_RE) ?? [])];
}

// The plan body as the factory expects it: the plan marker first; then the
// plan; then the ack markers (those already in `priorBody`, the draft's own,
// and one `replan-ack` per comment id in `ack`); then the session marker last.
// Returns {body, missing[], size}.
export function preparePlanBody(raw, { priorBody = "", ack = [] } = {}) {
  let text = String(raw ?? "").trim();
  if (text.startsWith(FACTORY_PLAN_MARKER)) text = text.slice(FACTORY_PLAN_MARKER.length).trim();
  for (const id of ack) {
    if (!/^\d+$/.test(String(id))) throw new DriveError(`--ack takes comment ids, got "${id}"`);
  }
  const acks = [
    ...new Set([
      ...planAckMarkers(priorBody),
      ...planAckMarkers(text),
      ...ack.map((id) => `<!-- drafto-factory-replan-ack:${id} -->`),
    ]),
  ];
  text = text
    .replace(PLAN_ACK_RE, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith(`<!-- ${SESSION_MARKER_PREFIX}plan`))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const headings = new Set(
    text
      .split("\n")
      .map((l) => /^###\s+(.+?)\s*$/.exec(l)?.[1])
      .filter(Boolean),
  );
  const missing = PLAN_SECTIONS.filter((s) => !headings.has(s));
  const size = parsePlanSize(text);
  if (!size)
    missing.push("plan-size marker (<!-- drafto-factory-plan-size:<S|M|L|XL>:<lines> -->)");
  return {
    body: `${FACTORY_PLAN_MARKER}\n\n${text}\n\n${acks.length ? `${acks.join("\n")}\n` : ""}${sessionMarker("plan")}\n`,
    missing,
    size,
  };
}

// The scenario body with the factory's markers closing it (any copies in the
// draft are dropped first), then the session marker.
export function prepareScenarioBody(raw, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? ""))
    throw new DriveError("--sha must be the full 40-char PR head SHA");
  const drop = (line) => {
    const t = line.trim();
    return (
      SCENARIO_MARKERS.includes(t) ||
      t.startsWith("<!-- drafto-factory-scenario-sha:") ||
      t.startsWith(`<!-- ${SESSION_MARKER_PREFIX}`)
    );
  };
  const text = String(raw ?? "")
    .split("\n")
    .filter((l) => !drop(l))
    .join("\n")
    .trim();
  return [
    `🧑‍💻 **Interactive session · ${LOG_STEPS.scenario}**`,
    "",
    text,
    "",
    ...SCENARIO_MARKERS,
    `<!-- drafto-factory-scenario-sha:${sha} -->`,
    sessionMarker("scenario", sha.slice(0, 12)),
    "",
  ].join("\n");
}

// The status:* labels to add and remove for a move to `status`.
export function labelSwap(currentLabels, status) {
  const add = statusLabelFor(status);
  const remove = (currentLabels ?? []).filter((l) => ALL_STATUS_LABELS.includes(l) && l !== add);
  return { add, remove };
}

// Why a card can't be handed back in column `to`: {hard, soft}, each a
// reason or "". `hard` (no column, an unknown one, Planning) always refuses;
// `soft` (the plan comment or open PR the column needs) yields to --force.
export function handbackBlocker(to, { hasPlan, pr, issue }) {
  const out = { hard: "", soft: "" };
  if (!to) out.hard = "the card's column can't be read";
  else if (to === "Planning")
    out.hard = "Planning is the factory's own transient column; hand back to Ready instead";
  else if (!BOARD_COLUMNS.has(to)) out.hard = `unknown column "${to}"`;
  else if (PLAN_REQUIRED_COLUMNS.has(to) && !hasPlan) {
    out.soft = `${to} needs the factory plan comment (post it with \`drive-issue plan ${issue}\`)`;
  } else if (PR_REQUIRED_COLUMNS.has(to) && (!pr || pr.state !== "OPEN")) {
    out.soft = `${to} needs an open PR on ${branchFor(issue)}`;
  }
  return out;
}

// Handing a card forward past a human gate needs that gate's approval in the
// session log first, because the factory acts on the column alone: into In
// Progress or later from before it needs `plan-approved` newer than the latest
// plan or replan; into Approved (or Released) from before it needs `approved`
// newer than the latest revision. Returns the reason, or "".
export function approvalBlocker(to, from, comments) {
  const at = (col) => COLUMN_ORDER.indexOf(col);
  const fromAt = at(from ?? "");
  if (at(to) >= at("In Progress") && fromAt !== -1 && fromAt < at("In Progress")) {
    const ok =
      lastEntryIndex(comments, ["plan-approved"]) > lastEntryIndex(comments, ["plan", "replan"]);
    if (!ok) {
      return "the plan isn't approved in this session (gate 1): log plan-approved after the operator approves, or hand back to Plan Review";
    }
  }
  if (at(to) >= at("Approved") && fromAt !== -1 && fromAt < at("Approved")) {
    const ok =
      lastEntryIndex(comments, ["approved"]) > lastEntryIndex(comments, ["revision"]) &&
      lastEntryIndex(comments, ["approved"]) !== -1;
    if (!ok) {
      return "the merge isn't approved in this session (gate 2): log approved after the operator approves, or hand back to In Test";
    }
  }
  return "";
}

// ── Driver ──────────────────────────────────────────────────────────────────

export function createDriver({
  exec = defaultExec,
  project = projectLib,
  repoRoot,
  nonce = () => randomBytes(4).toString("hex"),
  now = () => Date.now(),
} = {}) {
  const root = repoRoot ?? SCRIPT_REPO_ROOT;

  async function gh(args, { stdin, allowFail = false } = {}) {
    const r = await exec("gh", args, { stdin });
    if (r.code !== 0 && !allowFail) {
      throw new DriveError(
        `gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim()}`,
      );
    }
    return r;
  }

  async function issueView(issue) {
    const r = await gh([
      "issue",
      "view",
      String(issue),
      "--repo",
      REPO,
      "--json",
      "number,state,title,body,labels,url",
    ]);
    const data = JSON.parse(r.stdout);
    return { ...data, labels: (data.labels ?? []).map((l) => l.name) };
  }

  async function issueComments(issue) {
    const r = await gh([
      "api",
      `repos/${REPO}/issues/${issue}/comments`,
      "--paginate",
      "--jq",
      ".[] | {id, authorAssociation: .author_association, body, createdAt: .created_at, url: .html_url} | @json",
    ]);
    return r.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  async function postComment(issue, body) {
    const r = await gh(["issue", "comment", String(issue), "--repo", REPO, "--body-file", "-"], {
      stdin: body,
    });
    return r.stdout.trim();
  }

  async function editComment(id, body) {
    await gh(["api", "--method", "PATCH", `repos/${REPO}/issues/comments/${id}`, "--input", "-"], {
      stdin: JSON.stringify({ body }),
    });
  }

  // The card's PR: on factory/issue-<n> in this repo. The repo is public, so a
  // fork can open a PR from a branch of the same name; those never count.
  async function findPr(issue, prNumber) {
    const fields =
      "number,url,state,isDraft,isCrossRepository,baseRefName,headRefName,headRefOid,body,labels,mergeable,mergeStateStatus";
    const r = prNumber
      ? await gh(["pr", "view", String(prNumber), "--repo", REPO, "--json", fields])
      : await gh([
          "pr",
          "list",
          "--repo",
          REPO,
          "--head",
          branchFor(issue),
          "--state",
          "all",
          "--json",
          fields,
          "--limit",
          "20",
        ]);
    const data = JSON.parse(r.stdout);
    const own = (Array.isArray(data) ? data : [data]).filter(
      (p) => p && p.isCrossRepository !== true && p.headRefName === branchFor(issue),
    );
    if (prNumber && own.length === 0) {
      throw new DriveError(`PR #${prNumber} isn't on ${branchFor(issue)} in ${REPO}`);
    }
    // gh lists newest first; an open PR wins over an older closed one.
    const pr = own.find((p) => p.state === "OPEN") ?? own[0] ?? null;
    if (!pr) return null;
    return { ...pr, labels: (pr.labels ?? []).map((l) => l.name) };
  }

  async function prFiles(prNumber) {
    const r = await gh(["pr", "diff", String(prNumber), "--repo", REPO, "--name-only"]);
    return r.stdout.split("\n").filter(Boolean);
  }

  async function card(issue) {
    const projectId = await project.resolveProjectId({});
    const item = await project.findItemForIssue(projectId, issue, { repo: REPO });
    if (!item) throw new DriveError(`issue #${issue} not found`);
    return { projectId, ...item };
  }

  // Board first, then the label, as transition_status does.
  async function setColumn(issue, labels, status, c) {
    await project.setItemStatusByName({
      projectId: c.projectId,
      itemId: c.itemId,
      statusName: status,
    });
    await syncStatusLabel(issue, labels, status);
  }

  // Make the status:* labels say `status` (a no-op when they already do).
  async function syncStatusLabel(issue, labels, status) {
    const { add, remove } = labelSwap(labels, status);
    const args = ["issue", "edit", String(issue), "--repo", REPO];
    if (add && !labels.includes(add)) args.push("--add-label", add);
    for (const l of remove) args.push("--remove-label", l);
    if (args.length > 5) await gh(args);
  }

  // Put a claimed card on the board (in Ready) if it isn't there yet. Safe to
  // repeat: a claim interrupted between the label and the board is finished
  // by `claim --resume`.
  async function ensureOnBoard(issue, labels, c) {
    let { itemId, status } = c;
    let addedToBoard = false;
    if (!itemId) {
      itemId = await project.addIssueToProject(c.projectId, c.contentId);
      addedToBoard = true;
    }
    if (!status) {
      status = "Ready";
      await setColumn(issue, labels, status, { ...c, itemId });
    } else {
      // The board already has a column: make the label agree (a claim that
      // moved the board but failed on the label is finished here).
      await syncStatusLabel(issue, labels, status);
    }
    return { itemId, status, addedToBoard };
  }

  async function deleteComment(url) {
    const id = /issuecomment-(\d+)/.exec(url ?? "")?.[1];
    if (id) {
      await gh(["api", "--method", "DELETE", `repos/${REPO}/issues/comments/${id}`], {
        allowFail: true,
      });
    }
  }

  function requireClaim(issueData, force) {
    if (!issueData.labels.includes(DRIVER_LABEL) && !force) {
      throw new DriveError(
        `#${issueData.number} isn't claimed by an interactive session; run \`drive-issue claim ${issueData.number}\` first`,
      );
    }
  }

  async function log(issue, { step, body = "", key = "", heading, force = false } = {}) {
    const data = await issueView(issue);
    if (step !== "handback") requireClaim(data, force);
    if (key) {
      const prior = ownerCommentWithMarker(await issueComments(issue), sessionMarker(step, key));
      if (prior) return { posted: false, url: prior.url, step, key };
    }
    const url = await postComment(issue, renderLogComment({ step, body, key, heading }));
    return { posted: true, url, step, key };
  }

  async function claim(issue, { force = false, resume = false } = {}) {
    const data = await issueView(issue);
    if (data.state !== "OPEN") throw new DriveError(`#${issue} is ${data.state}, not OPEN`);
    const c = await card(issue);
    const pr = await findPr(issue);
    if (data.labels.includes(DRIVER_LABEL)) {
      // Two sessions driving one card would race on the branch, the column and
      // the comments, so an existing claim is only picked up on purpose.
      if (!resume) {
        const prior = sessionEntries(await issueComments(issue), "claim").at(-1);
        throw new DriveError(
          `#${issue} is already claimed by an interactive session` +
            (prior ? ` (${prior.createdAt}: ${prior.url})` : "") +
            ". If that session is yours and has ended, re-run with --resume; " +
            "if another session is still driving it, leave the card to it.",
        );
      }
      const board = await ensureOnBoard(issue, data.labels, c);
      await log(issue, {
        step: "claim",
        heading: "Claim resumed",
        body:
          `A new interactive session picked up the existing claim. Column: ${board.status}` +
          `${board.addedToBoard ? " (added to the board: the first claim stopped before it)" : ""}.`,
      });
      return {
        issue,
        already: true,
        status: board.status,
        addedToBoard: board.addedToBoard,
        branch: branchFor(issue),
        pr: pr?.url ?? null,
      };
    }
    if (c.status && RISKY_CLAIM_COLUMNS.includes(c.status) && !force) {
      throw new DriveError(
        `#${issue} is in ${c.status}, where a factory run may be live. On the Mac mini, check that no ` +
          "tick is running (`pgrep -fl factory-agent.sh`) and that " +
          `\`node scripts/lib/implement-lane.mjs status --issue ${issue}\` lists no run, ` +
          "then re-run with --force. A detached run that ends while the card is claimed is held, not collected.",
      );
    }
    // Label first, so the factory never sees the card on the board unclaimed.
    await gh(["issue", "edit", String(issue), "--repo", REPO, "--add-label", DRIVER_LABEL]);
    // Two sessions can both pass the label check above. Each claim log entry
    // carries its own nonce; the earliest claim since the last handback wins,
    // and every other one withdraws its entry and stops. release() logs the
    // handback before it removes the label, so any claim that saw the card
    // unclaimed was posted after that handback entry and takes part here.
    const key = nonce();
    const entry = await log(issue, {
      step: "claim",
      key,
      body: `Claiming… (claim \`${key}\`)`,
      force: true,
    });
    const comments = await issueComments(issue);
    const since = lastEntryIndex(comments, ["handback"]);
    const winner = sessionEntries(comments.slice(since + 1), "claim")[0];
    if (!winner || winner.url !== entry.url) {
      await deleteComment(entry.url);
      throw new DriveError(
        winner
          ? `lost a claim race: another session claimed #${issue} first (${winner.url}). Leave the card to it.`
          : `couldn't confirm the claim on #${issue} (a handback landed after it); run status and claim again`,
      );
    }
    const board = await ensureOnBoard(issue, data.labels, c);
    const lines = [
      `This card is now driven from an interactive Claude Code session (claim \`${key}\`). The factory skips it while \`${DRIVER_LABEL}\` is on.`,
      "",
      `- **Column:** ${board.status}${board.addedToBoard ? " (added to the board)" : ""}`,
      `- **Branch:** \`${branchFor(issue)}\``,
      `- **PR:** ${pr ? `${pr.url} (${pr.state})` : "none yet"}`,
    ];
    if (data.labels.includes("factory-pause")) lines.push("- `factory-pause` is also set.");
    lines.push(
      "",
      `Hand it back with \`node scripts/drive-issue.mjs release ${issue} --to <column> --note …\`.`,
    );
    const finalBody = renderLogComment({ step: "claim", key, body: lines.join("\n") });
    const claimId = /issuecomment-(\d+)/.exec(entry.url ?? "")?.[1];
    if (claimId) await editComment(claimId, finalBody);
    return {
      issue,
      already: false,
      status: board.status,
      addedToBoard: board.addedToBoard,
      branch: branchFor(issue),
      pr: pr?.url ?? null,
      log: entry.url,
    };
  }

  async function move(issue, status, { note, force = false } = {}) {
    if (!BOARD_COLUMNS.has(status)) throw new DriveError(`unknown column "${status}"`);
    if (!note || !String(note).trim())
      throw new DriveError("move needs --note: say why the card moves");
    const data = await issueView(issue);
    requireClaim(data, force);
    const c = await card(issue);
    if (!c.itemId) throw new DriveError(`#${issue} isn't on the board; run claim first`);
    await setColumn(issue, data.labels, status, c);
    const entry = await log(issue, {
      step: "move",
      heading: `${c.status ?? "—"} → ${status}`,
      body: note,
      force: true,
    });
    return { issue, from: c.status, to: status, log: entry.url };
  }

  async function spec(issue) {
    const data = await issueView(issue);
    const parsed = parseSpec(data.body ?? "");
    const override = effectiveParityOverride(data.labels, parsed) ?? "";
    return { issue, missing: specMissingSection(parsed, override), override, spec: parsed };
  }

  async function plan(issue, { body, note = "", ack = [], force = false } = {}) {
    const data = await issueView(issue);
    requireClaim(data, force);
    const existing = planCommentOf(await issueComments(issue));
    const prepared = preparePlanBody(body, { priorBody: existing?.body ?? "", ack });
    if (prepared.missing.length && !force) {
      throw new DriveError(
        `the plan is missing: ${prepared.missing.join(", ")} (see scripts/factory-plan-prompt.md § Plan structure)`,
      );
    }
    if (existing) {
      await editComment(existing.id, prepared.body);
      const entry = await log(issue, {
        step: "replan",
        body: `Plan edited in place: ${existing.url}${note ? `\n\n${note}` : ""}`,
        force,
      });
      return { issue, replanned: true, url: existing.url, log: entry.url, size: prepared.size };
    }
    const url = await postComment(issue, prepared.body);
    return { issue, replanned: false, url, size: prepared.size };
  }

  async function scenario(issue, { body, sha, force = false } = {}) {
    const data = await issueView(issue);
    requireClaim(data, force);
    const text = prepareScenarioBody(body, sha);
    const prior = ownerCommentWithMarker(
      await issueComments(issue),
      sessionMarker("scenario", sha.slice(0, 12)),
    );
    if (prior) {
      await editComment(prior.id, text);
      return { issue, edited: true, url: prior.url };
    }
    return { issue, edited: false, url: await postComment(issue, text) };
  }

  async function localFiles(base) {
    const mb = await exec("git", ["merge-base", base, "HEAD"], { cwd: root });
    if (mb.code !== 0)
      throw new DriveError(`git merge-base ${base} HEAD failed: ${mb.stderr.trim()}`);
    // -z: unquoted paths, so `apps/web/café.ts` still starts with apps/.
    const lists = [
      ["diff", "--name-only", "-z", mb.stdout.trim()],
      ["ls-files", "-z", "--others", "--exclude-standard"],
    ];
    const files = [];
    for (const args of lists) {
      const r = await exec("git", args, { cwd: root });
      if (r.code !== 0) throw new DriveError(`git ${args[0]} failed: ${r.stderr.trim()}`);
      files.push(...r.stdout.split("\0").filter(Boolean));
    }
    return [...new Set(files)];
  }

  async function parity(issue, { pr: prNumber, base = "origin/main" } = {}) {
    const { spec: parsed, override } = await spec(issue);
    const pr = prNumber ? await findPr(issue, prNumber) : null;
    const files = pr ? await prFiles(pr.number) : await localFiles(base);
    const violation = parityViolation({ platforms: parsed.affectedPlatforms, override, files });
    return {
      issue,
      source: pr ? `PR #${pr.number}` : `local diff vs ${base}`,
      platforms: parsed.affectedPlatforms,
      override,
      files: files.length,
      violation,
    };
  }

  async function migrationHash(pr) {
    const r = await exec(
      "node",
      [
        join(SCRIPTS_DIR, "lib", "migration-approval.mjs"),
        "hash",
        "--pr",
        String(pr.number),
        "--head",
        pr.headRefOid,
        "--root",
        root,
      ],
      { cwd: root },
    );
    if (r.code !== 0) throw new DriveError(`migration-approval hash failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout);
  }

  async function approveMigration(issue, { pr: prNumber, force = false } = {}) {
    const data = await issueView(issue);
    requireClaim(data, force);
    const pr = await findPr(issue, prNumber);
    if (!pr || pr.state !== "OPEN") throw new DriveError(`no open PR on ${branchFor(issue)}`);
    const { hash, files } = await migrationHash(pr);
    // The record first, the label second: a label must never sit on the PR
    // without the approval it stands for (gates and release check the record).
    const entry = await log(issue, {
      step: "migration-approved",
      key: `pr${pr.number}-${hash}-${now().toString(36)}`,
      body: [
        `The operator approved PR #${pr.number}'s migration SQL in this session (hash \`${hash}\`, head \`${pr.headRefOid.slice(0, 12)}\`).`,
        "",
        ...files.map((f) => `- \`${f}\``),
        "",
        "Any later change to this SQL voids the approval: `gates` and the factory's ADR-0078 check both re-hash it.",
      ].join("\n"),
      force,
    });
    await gh(["pr", "edit", String(pr.number), "--repo", REPO, "--add-label", MIGRATION_LABEL]);
    return { issue, pr: pr.number, hash, log: entry.url };
  }

  async function requiredChecks(prNumber) {
    const r = await gh(
      ["pr", "checks", String(prNumber), "--repo", REPO, "--required", "--json", "name,bucket"],
      {
        allowFail: true,
      },
    );
    let list;
    try {
      list = JSON.parse(r.stdout || "[]");
    } catch {
      return { ok: false, detail: (r.stderr || r.stdout).trim() || "couldn't read checks" };
    }
    if (!list.length)
      return { ok: false, detail: (r.stderr || "no required checks reported yet").trim() };
    const bad = list.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
    return bad.length
      ? { ok: false, detail: bad.map((c) => `${c.name}: ${c.bucket}`).join(", ") }
      : { ok: true, detail: `${list.length} required check(s) green` };
  }

  // Unresolved review threads across every page. A page that can't be read
  // throws, so the gate fails rather than counting it as empty.
  async function unresolvedThreads(prNumber) {
    const [owner, name] = REPO.split("/");
    let open = 0;
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      const args = [
        "api",
        "graphql",
        "-f",
        "query=query($o:String!,$n:String!,$p:Int!,$c:String){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor}nodes{isResolved}}}}}",
        "-f",
        `o=${owner}`,
        "-f",
        `n=${name}`,
        "-F",
        `p=${prNumber}`,
      ];
      if (cursor) args.push("-f", `c=${cursor}`);
      const conn = JSON.parse((await gh(args)).stdout)?.data?.repository?.pullRequest
        ?.reviewThreads;
      if (!conn) throw new DriveError(`couldn't read PR #${prNumber}'s review threads`);
      open += (conn.nodes ?? []).filter((t) => !t.isResolved).length;
      if (!conn.pageInfo?.hasNextPage) return open;
      cursor = conn.pageInfo.endCursor;
    }
    throw new DriveError(`PR #${prNumber} has more review threads than this check reads`);
  }

  // Fetch main and the PR head so the ref-reading checks see current commits.
  // Returns "" or the reason the refs can't be trusted.
  async function refreshRefs(pr) {
    const f = await exec("git", ["fetch", "--quiet", "origin", "main", pr.headRefName], {
      cwd: root,
    });
    if (f.code !== 0) return `git fetch failed: ${f.stderr.trim() || `exit ${f.code}`}`;
    const has = await exec("git", ["cat-file", "-e", `${pr.headRefOid}^{commit}`], { cwd: root });
    if (has.code !== 0) return `the PR head ${pr.headRefOid.slice(0, 12)} isn't in the local clone`;
    return "";
  }

  // hosted-config.mjs on the PR head commit itself (not a moving ref):
  // {ok, detail}. Run refreshRefs first.
  async function hostedConfig(pr, where) {
    const hc = await exec(
      "node",
      [
        join(SCRIPTS_DIR, "lib", "hosted-config.mjs"),
        "check",
        "--base-ref",
        "origin/main",
        "--head-ref",
        pr.headRefOid,
        "--labels",
        pr.labels.join(","),
        "--pr",
        String(pr.number),
        "--where",
        where,
      ],
      { cwd: root },
    );
    const status = { 0: "ok", 3: "hold", 4: "unknown" }[hc.code] ?? "error";
    return {
      ok: status === "ok",
      detail:
        status === "ok"
          ? "nothing to apply"
          : `${status}: run \`pnpm hosted-config:check\` for what to apply to dev and prod`,
    };
  }

  // The --release merge gates, in the factory's order (factory-agent.sh
  // --release). Each entry: {name, ok, detail}.
  async function gates(issue, { pr: prNumber, logResult = false } = {}) {
    const { spec: parsed, override } = await spec(issue);
    const pr = await findPr(issue, prNumber);
    const checks = [];
    const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
    if (!pr || pr.state !== "OPEN") {
      add("open PR", false, `no open PR on ${branchFor(issue)}`);
      return { issue, ok: false, pr: pr?.number ?? null, checks };
    }
    // hosted-config, the migration order and the SQL hash read git refs.
    const stale = await refreshRefs(pr);
    if (stale) {
      add("refs up to date", false, stale);
      return { issue, ok: false, pr: pr.number, head: pr.headRefOid, checks };
    }
    const files = await prFiles(pr.number);
    const touchesMigrations = files.some((f) => f.startsWith("supabase/migrations/"));

    add(
      "ready, against main",
      !pr.isDraft && pr.baseRefName === "main",
      pr.isDraft ? "PR is a draft" : `base is ${pr.baseRefName}`,
    );
    add(
      "factory PR marker",
      (pr.body ?? "").trimStart().startsWith(PR_MARKER),
      "PR body must start with <!-- drafto-factory-pr --> so the factory can take it over",
    );
    const mig = migrationViolation(files, pr.labels);
    add(
      "migration-approved label",
      !mig,
      mig || (touchesMigrations ? "label present" : "no migrations"),
    );
    if (touchesMigrations && !mig) {
      // A merge from the session needs the operator's approval of exactly this
      // SQL, recorded by approve-migration: a label alone (added on the board,
      // or left by a failed approve-migration) isn't enough.
      const approval = latestMigrationApproval(await issueComments(issue), pr.number);
      if (!approval) {
        add(
          "migration SQL approved in session",
          false,
          "no approval recorded for this PR; after the operator's explicit yes, run approve-migration",
        );
      } else {
        const { hash } = await migrationHash(pr);
        add(
          "migration SQL approved in session",
          approval.hash === hash,
          approval.hash === hash
            ? `hash ${hash}`
            : `SQL hash is now ${hash}, approved ${approval.hash}; ask the operator again, then approve-migration`,
        );
      }
    }
    const par = parityViolation({ platforms: parsed.affectedPlatforms, override, files });
    add("parity", !par, par || "every claimed platform has changes");
    add("no conflicts", pr.mergeable === "MERGEABLE", `mergeable: ${pr.mergeable}`);
    if (touchesMigrations) {
      const head = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
      if (head.stdout.trim() !== pr.headRefOid) {
        add(
          "migration order",
          false,
          `check out the PR head (${pr.headRefOid.slice(0, 12)}) locally first`,
        );
      } else {
        const order = await exec(
          "node",
          [join(SCRIPTS_DIR, "lib", "check-migration-order.mjs"), "--base", "origin/main"],
          { cwd: root },
        );
        const errors = order.stdout
          .split("\n")
          .filter((l) => l.startsWith("error\t") || l.startsWith("move\t"));
        add(
          "migration order",
          order.code === 0 && errors.length === 0,
          errors.length
            ? errors.map((l) => l.split("\t").slice(1, 3).join(": ")).join("; ")
            : order.stderr.trim() || "sorts after main",
        );
      }
    }
    const ci = await requiredChecks(pr.number);
    add("required CI green", ci.ok, ci.detail);
    add(
      "up to date with main",
      pr.mergeStateStatus !== "BEHIND",
      `merge state: ${pr.mergeStateStatus}`,
    );
    const open = await unresolvedThreads(pr.number);
    add("review threads resolved", open === 0, `${open} unresolved`);
    const hc = await hostedConfig(pr, "Approved");
    add("hosted config applied", hc.ok, hc.detail);
    // Every check above must describe one commit. A push mid-run invalidates
    // the result.
    const after = await findPr(issue, pr.number);
    add(
      "head unchanged while checking",
      after?.headRefOid === pr.headRefOid,
      after?.headRefOid === pr.headRefOid
        ? pr.headRefOid.slice(0, 12)
        : `moved to ${String(after?.headRefOid).slice(0, 12)}; re-run gates`,
    );

    const ok = checks.every((c) => c.ok);
    let logUrl = null;
    if (logResult) {
      const entry = await log(issue, {
        step: "gates",
        // One entry per head and outcome: a re-run with the same results
        // posts nothing, a changed result posts anew.
        key: `${pr.headRefOid.slice(0, 12)}-${checks.map((c) => (c.ok ? 1 : 0)).join("")}`,
        body: [
          `PR #${pr.number} at \`${pr.headRefOid.slice(0, 12)}\`: **${ok ? "all gates pass" : "blocked"}**`,
          "",
          ...checks.map(
            (c) => `- ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
          ),
        ].join("\n"),
      });
      logUrl = entry.url;
    }
    return { issue, ok, pr: pr.number, head: pr.headRefOid, checks, log: logUrl };
  }

  function handbackBody(issue, note, column, pr, markerAdded) {
    return [
      String(note).trim(),
      "",
      `- **Column:** ${column ?? "unknown"}`,
      `- **PR:** ${pr ? `${pr.url} (${pr.state})` : "none"}${markerAdded ? " — added the factory PR marker" : ""}`,
      `- **Factory next:** ${(HANDBACK_NEXT[column] ?? "picks the card up on its next tick.").replace("<n>", String(issue))}`,
    ].join("\n");
  }

  async function release(issue, { to, note, force = false } = {}) {
    if (!note || !String(note).trim())
      throw new DriveError("release needs --note: say what state the card is in");
    const data = await issueView(issue);
    const comments = await issueComments(issue);
    const c = await card(issue);
    const pr = await findPr(issue);
    if (!data.labels.includes(DRIVER_LABEL)) {
      // An earlier release took the label off but couldn't post its log:
      // post just the log now, with no board or PR writes.
      if (lastEntryIndex(comments, ["claim"]) > lastEntryIndex(comments, ["handback"])) {
        const entry = await log(issue, {
          step: "handback",
          body: handbackBody(issue, note, c.status, pr, false),
        });
        return { issue, column: c.status, pr: pr?.url ?? null, logOnly: true, log: entry.url };
      }
      throw new DriveError(`#${issue} isn't claimed (no ${DRIVER_LABEL} label)`);
    }
    // Without --to the card stays where it is, and that column is checked.
    const column = to ?? c.status;
    const blocker = handbackBlocker(column, {
      hasPlan: Boolean(planCommentOf(comments)),
      pr,
      issue,
    });
    if (blocker.hard)
      throw new DriveError(`can't hand back in ${column ?? "no column"}: ${blocker.hard}`);
    if (blocker.soft && !force)
      throw new DriveError(`can't hand back in ${column}: ${blocker.soft}`);
    const gate = approvalBlocker(column, c.status, comments);
    if (gate) throw new DriveError(`can't hand back in ${column}: ${gate}`);
    // The factory vouches for the SQL it first sees with the label (ADR-0078),
    // so handing back a label the operator gave to older SQL would pass the new
    // SQL off as approved.
    if (pr && pr.state === "OPEN" && pr.labels.includes(MIGRATION_LABEL)) {
      const approval = latestMigrationApproval(comments, pr.number);
      if (approval) {
        const stale = await refreshRefs(pr);
        if (stale) throw new DriveError(`can't check the approved migration SQL: ${stale}`);
        const { hash } = await migrationHash(pr);
        if (hash !== approval.hash) {
          throw new DriveError(
            `PR #${pr.number}'s migration SQL changed since the operator approved it (approved ${approval.hash}, now ${hash}). ` +
              `Get a new yes and run approve-migration, or remove the ${MIGRATION_LABEL} label, before handing back.`,
          );
        }
      }
    }
    let markerAdded = false;
    if (pr && pr.state === "OPEN" && !(pr.body ?? "").trimStart().startsWith(PR_MARKER)) {
      await gh(["pr", "edit", String(pr.number), "--repo", REPO, "--body-file", "-"], {
        stdin: `${PR_MARKER}\n\n${pr.body ?? ""}`,
      });
      markerAdded = true;
    }
    // Reconcile the label even when the column already matches: a release that
    // moved the board but failed on the label is finished here.
    if (column !== c.status) await setColumn(issue, data.labels, column, c);
    else await syncStatusLabel(issue, data.labels, column);
    // The handback entry first, then the label: a session that sees the card
    // unclaimed always finds this entry before its own claim, so claim()'s
    // election stays sound. If the label can't come off, the entry is
    // withdrawn, so the log never shows a handback that didn't happen.
    const entry = await log(issue, {
      step: "handback",
      body: handbackBody(issue, note, column, pr, markerAdded),
    });
    const off = await gh(
      ["issue", "edit", String(issue), "--repo", REPO, "--remove-label", DRIVER_LABEL],
      { allowFail: true },
    );
    if (off.code !== 0) {
      await deleteComment(entry.url);
      throw new DriveError(
        `couldn't remove ${DRIVER_LABEL} (${(off.stderr || off.stdout).trim()}); the handback entry was withdrawn. Re-run release.`,
      );
    }
    return { issue, column, pr: pr?.url ?? null, markerAdded, log: entry.url };
  }

  // Squash-merge the card's PR at exactly the head `gates` passed: GitHub's
  // `sha` parameter refuses the merge if the head moved after the check.
  async function merge(issue, { pr: prNumber } = {}) {
    requireClaim(await issueView(issue), false);
    const result = await gates(issue, { pr: prNumber, logResult: true });
    if (!result.ok) {
      const failed = result.checks.filter((ch) => !ch.ok).map((ch) => ch.name);
      throw new DriveError(`gates failed (${failed.join(", ")}); nothing merged`);
    }
    const r = await gh(
      [
        "api",
        "--method",
        "PUT",
        `repos/${REPO}/pulls/${result.pr}/merge`,
        "-f",
        "merge_method=squash",
        "-f",
        `sha=${result.head}`,
      ],
      { allowFail: true },
    );
    let body = {};
    try {
      body = JSON.parse(r.stdout || "{}");
    } catch {
      body = {};
    }
    if (r.code !== 0 || body.merged !== true) {
      throw new DriveError(
        `GitHub refused the merge of PR #${result.pr} at ${result.head.slice(0, 12)}: ` +
          `${body.message || r.stderr.trim() || "unknown error"}`,
      );
    }
    const entry = await log(issue, {
      step: "merged",
      key: String(body.sha ?? "").slice(0, 12),
      body: `Squash-merged PR #${result.pr} at the gated head \`${result.head.slice(0, 12)}\` as \`${String(body.sha ?? "").slice(0, 12)}\`.`,
    });
    return { issue, pr: result.pr, head: result.head, mergeSha: body.sha ?? null, log: entry.url };
  }

  // The hosted-config gate on its own, for a pre-merge beta dispatch.
  async function hostedConfigGate(issue, { pr: prNumber } = {}) {
    const pr = await findPr(issue, prNumber);
    if (!pr || pr.state !== "OPEN") throw new DriveError(`no open PR on ${branchFor(issue)}`);
    const stale = await refreshRefs(pr);
    if (stale) return { issue, pr: pr.number, head: pr.headRefOid, ok: false, detail: stale };
    return { issue, pr: pr.number, head: pr.headRefOid, ...(await hostedConfig(pr, "beta")) };
  }

  async function status(issue) {
    const data = await issueView(issue);
    const c = await card(issue);
    const comments = await issueComments(issue);
    const pr = await findPr(issue);
    const logEntries = comments
      .filter((cm) => cm.authorAssociation === "OWNER")
      .map((cm) => ({
        cm,
        m: new RegExp(`<!-- ${SESSION_MARKER_PREFIX}([a-z-]+)`).exec(cm.body ?? ""),
      }))
      .filter((x) => x.m)
      .map((x) => ({ step: x.m[1], at: x.cm.createdAt, url: x.cm.url }));
    return {
      issue,
      title: data.title,
      state: data.state,
      column: c.status,
      onBoard: Boolean(c.itemId),
      driver: data.labels.includes(DRIVER_LABEL)
        ? "interactive"
        : data.labels.includes("factory-pause")
          ? "paused"
          : "factory",
      labels: data.labels,
      plan: planCommentOf(comments)?.url ?? null,
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state, head: pr.headRefOid } : null,
      branch: branchFor(issue),
      recentLog: logEntries.slice(-8),
    };
  }

  return {
    claim,
    move,
    log,
    spec,
    plan,
    scenario,
    parity,
    approveMigration,
    gates,
    merge,
    hostedConfig: hostedConfigGate,
    release,
    status,
  };
}

// ── Process plumbing ────────────────────────────────────────────────────────

function defaultExec(cmd, args, { stdin, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // A child that exits before reading its stdin (gh failing auth, say) makes
    // the write fail with EPIPE; the exit code and stderr tell the real story.
    child.stdin.on("error", () => {});
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const booleans = new Set(["force", "json", "log", "resume"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (booleans.has(key)) flags[key] = true;
      else {
        if (i + 1 >= argv.length) throw new DriveError(`--${key} needs a value`);
        flags[key] = argv[++i];
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

function readText(flags, name, { required = false } = {}) {
  if (flags[name] !== undefined) return flags[name];
  const file = flags[`${name}-file`];
  if (file !== undefined) return readFileSync(file === "-" ? 0 : file, "utf8");
  if (required) throw new DriveError(`pass --${name} <text> or --${name}-file <path|->`);
  return "";
}

function issueArg(positional) {
  const n = Number(positional[1]);
  if (!Number.isInteger(n) || n <= 0)
    throw new DriveError("the second argument must be an issue number");
  return n;
}

function render(cmd, result) {
  switch (cmd) {
    case "spec":
      return result.missing
        ? `❌ spec gate: missing "${result.missing}"`
        : `✅ spec gate passes (platforms: ${result.spec.affectedPlatforms.join(", ") || "none"}${result.override ? `, override ${result.override}` : ""})`;
    case "parity":
      return result.violation
        ? `❌ parity (${result.source}): ${result.violation}`
        : `✅ parity (${result.source}, ${result.files} files)`;
    case "hosted-config":
      return `${result.ok ? "✅" : "❌"} hosted config (PR #${result.pr} at ${result.head.slice(0, 12)}): ${result.detail}`;
    case "gates":
      return [
        `${result.ok ? "✅ all gates pass" : "❌ blocked"} — PR #${result.pr ?? "?"}`,
        ...result.checks.map(
          (c) => `  ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`,
        ),
        result.log ? `logged: ${result.log}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return JSON.stringify(result, null, 2);
  }
}

export async function main(argv, driver = createDriver()) {
  const { flags, positional } = parseArgs(argv);
  const cmd = positional[0];
  let result;
  switch (cmd) {
    case "claim":
      result = await driver.claim(issueArg(positional), {
        force: flags.force,
        resume: flags.resume,
      });
      break;
    case "status":
      result = await driver.status(issueArg(positional));
      break;
    case "spec":
      result = await driver.spec(issueArg(positional));
      break;
    case "move":
      result = await driver.move(issueArg(positional), positional.slice(2).join(" "), {
        note: readText(flags, "note", { required: true }),
        force: flags.force,
      });
      break;
    case "log":
      if (!flags.step) throw new DriveError("log needs --step <step>");
      result = await driver.log(issueArg(positional), {
        step: flags.step,
        body: readText(flags, "body", { required: true }),
        key: flags.key ?? "",
        force: flags.force,
      });
      break;
    case "plan":
      result = await driver.plan(issueArg(positional), {
        body: readText(flags, "body", { required: true }),
        note: readText(flags, "note"),
        ack: (flags.ack ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        force: flags.force,
      });
      break;
    case "scenario":
      result = await driver.scenario(issueArg(positional), {
        body: readText(flags, "body", { required: true }),
        sha: flags.sha,
        force: flags.force,
      });
      break;
    case "parity":
      result = await driver.parity(issueArg(positional), { pr: flags.pr, base: flags.base });
      break;
    case "approve-migration":
      result = await driver.approveMigration(issueArg(positional), {
        pr: flags.pr,
        force: flags.force,
      });
      break;
    case "gates":
      result = await driver.gates(issueArg(positional), { pr: flags.pr, logResult: flags.log });
      break;
    case "merge":
      result = await driver.merge(issueArg(positional), { pr: flags.pr });
      break;
    case "hosted-config":
      result = await driver.hostedConfig(issueArg(positional), { pr: flags.pr });
      break;
    case "release":
      result = await driver.release(issueArg(positional), {
        to: flags.to,
        note: readText(flags, "note", { required: true }),
        force: flags.force,
      });
      break;
    default:
      throw new DriveError(
        "Usage: drive-issue.mjs <claim|status|spec|move|log|plan|scenario|parity|approve-migration|gates|merge|hosted-config|release> <issue> [flags]\n" +
          "See the header of scripts/drive-issue.mjs or docs/features/interactive-driving.md.",
      );
  }
  const failed =
    (cmd === "spec" && Boolean(result.missing)) ||
    (cmd === "parity" && Boolean(result.violation)) ||
    (cmd === "gates" && !result.ok) ||
    (cmd === "hosted-config" && !result.ok);
  return {
    text: flags.json ? JSON.stringify(result, null, 2) : render(cmd, result),
    code: failed ? 1 : 0,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    ({ text, code }) => {
      process.stdout.write(`${text}\n`);
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`drive-issue: ${err.message}\n`);
      process.exitCode = err instanceof DriveError ? 2 : 1;
    },
  );
}
