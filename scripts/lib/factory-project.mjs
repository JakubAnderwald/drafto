#!/usr/bin/env node
// GraphQL reader/writer for the dark-factory Project v2 board.
//
// Replaces the role originally assigned to `.github/workflows/factory-status-mirror.yml`
// (retired before Phase A landed — `projects_v2_item` events are documented
// org-only and never fire for user-owned boards). Instead, the Mac-mini
// factory-agent polls the board directly on its 5-min tick via this module.
//
// Functions (all use `gh api graphql` so the auth model is identical to the
// rest of the support pipeline — no new tokens, no new env vars):
//
//   findProject({owner, title}) → {projectId, projectNumber, projectUrl} | null
//        Look up the project by owner login + title (defaults: viewer login,
//        "Drafto Factory"). Returns null if the board doesn't exist yet.
//
//   getStatusFieldMeta(projectId) → {statusFieldId, options[], optionsByName{}}
//        Fetch the Status single-select field metadata. Used by callers to
//        translate a Status name (e.g. "Ready") into the option id required
//        by the setStatus mutation.
//
//   queryStatusItems(projectId, statusName, {repo, limit}) → ProjectItem[]
//        Return every item on the board whose Status matches `statusName`,
//        scoped to issues (Project v2 can contain draft items, PRs, and
//        cross-repo issues — Phase A only cares about issues in the
//        target repo). Each entry is {itemId, contentId, issueNumber,
//        title, url, status, labels, repoNameWithOwner}.
//
//   setItemStatus({projectId, itemId, statusFieldId, optionId})
//        Mutate the item's Status field. Caller resolves optionId from
//        getStatusFieldMeta first (avoids re-fetching meta per item).
//
//   setItemStatusByName({projectId, itemId, statusName}) — convenience
//        Combines getStatusFieldMeta + setItemStatus when you don't already
//        hold the meta. Caches meta per-projectId per-process.
//
//   hasStatusOption(projectId, name) → boolean (read-only)
//        Whether the Status field has an option with exactly this name. Lets
//        a caller check a column exists (e.g. "Testing") before moving a card
//        there, so set-status can't throw and strand the card.
//
//   exportStatuses(projectId) → [{itemId, issueNumber, status, type}] (read-only)
//        Every item on the board, any repo or content type, sorted by
//        issueNumber then itemId. A backup taken before a board migration
//        (scripts/setup-factory-board.sh) and diffed against a re-export
//        after it. type is the content's __typename; issueNumber is the
//        issue's (or a PR's) number and null for a draft item; status is
//        null for an item with no Status.
//
// CLI (called from scripts/factory-agent.sh):
//   find-project [--owner <login>] [--title <title>]
//   get-status-meta [--project-id <id>] [--owner <login>] [--title <title>]
//   has-status-option --name <option> [--project-id <id>]
//                     [--owner <login>] [--title <title>]
//   export-statuses [--project-id <id>] [--owner <login>] [--title <title>]
//   query-status-items --status <name> [--project-id <id>]
//                      [--owner <login>] [--title <title>]
//                      [--repo <owner/name>] [--limit <n>]
//   set-status --item-id <id> --status <name> [--project-id <id>]
//              [--owner <login>] [--title <title>]
//
// All subcommands print JSON to stdout and exit 0; errors print
// `{"error": "..."}` to stderr and exit non-zero — same shape as
// github-sync.mjs / state-cli.mjs. The one exception is has-status-option:
// it prints {"name", "present"} and exits 1 when the option is absent, so
// bash can branch on the exit code (non-zero = absent or the lookup failed).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ghTimeoutMs } from "./gh-timeout.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

const execFileP = promisify(execFile);

export const DEFAULT_REPO = "JakubAnderwald/drafto";
export const DEFAULT_PROJECT_TITLE = "Drafto Factory";

// Project v2 items query page size. GitHub caps singleselect-field reads at
// 100 per page; keep one knob.
const ITEMS_PAGE_SIZE = 100;

let _execFileForTests = null;
let _sleepForTests = null;

export function _setExecFileForTests(impl) {
  _execFileForTests = impl;
}

export function _setSleepForTests(impl) {
  _sleepForTests = impl;
}

// Same transient-error rules as github-sync.mjs's runGh — keep flaky GitHub
// hiccups from spamming `factory-failure` issues on the 5-min tick.
function isTransientGhError(err) {
  const text = `${err?.message ?? ""} ${err?.stderr ?? ""} ${err?.stdout ?? ""}`;
  if (/\bHTTP\s+(?:429|500|502|503|504)\b/i.test(text)) return true;
  if (/\bgateway\s+time-?out\b/i.test(text)) return true;
  if (/\b(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:connection reset|i\/o timeout|temporary failure)\b/i.test(text)) return true;
  return false;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];

async function runGh(args, { stdin } = {}) {
  const fn = _execFileForTests ?? execFileP;
  const sleep = _sleepForTests ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // A hung gh is killed at the cap and rejects as a non-transient error,
      // so it fails fast instead of being retried (gh-timeout.mjs). SIGKILL,
      // as in comment-intest-build.mjs: execFile never escalates past its
      // killSignal, so a gh that ignored TERM would still hang the caller.
      const opts = {
        maxBuffer: 16 * 1024 * 1024,
        timeout: ghTimeoutMs(),
        killSignal: "SIGKILL",
      };
      if (stdin != null) opts.input = stdin;
      const { stdout } = await fn("gh", args, opts);
      return stdout;
    } catch (err) {
      lastError = err;
      if (attempt === RETRY_DELAYS_MS.length || !isTransientGhError(err)) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

// Resolve the authenticated viewer's login. Used as the default owner when
// the caller doesn't pass one.
let _cachedViewerLogin = null;
export function _resetViewerCacheForTests() {
  _cachedViewerLogin = null;
}

async function resolveViewerLogin() {
  if (_cachedViewerLogin) return _cachedViewerLogin;
  const raw = await runGh(["api", "graphql", "-f", "query={ viewer { login } }"]);
  const data = JSON.parse(raw);
  const login = data?.data?.viewer?.login;
  if (!login) throw new Error("Could not resolve authenticated viewer login");
  _cachedViewerLogin = login;
  return login;
}

export async function findProject({ owner, title = DEFAULT_PROJECT_TITLE } = {}) {
  const resolvedOwner = owner ?? (await resolveViewerLogin());
  const raw = await runGh([
    "api",
    "graphql",
    "-f",
    `query=query($login: String!) {
      user(login: $login) {
        projectsV2(first: 100) {
          nodes { id number title }
        }
      }
    }`,
    "-f",
    `login=${resolvedOwner}`,
  ]);
  const data = JSON.parse(raw);
  const nodes = data?.data?.user?.projectsV2?.nodes ?? [];
  const match = nodes.find((n) => n?.title === title);
  if (!match) return null;
  return {
    projectId: match.id,
    projectNumber: match.number,
    projectUrl: `https://github.com/users/${resolvedOwner}/projects/${match.number}`,
  };
}

// Caller-side hook — bash sets FACTORY_PROJECT_ID once at startup. Direct env
// access (instead of resolveProjectId(...)) keeps single-shot CLI calls fast.
async function resolveProjectId({ projectId, owner, title } = {}) {
  if (projectId) return projectId;
  if (process.env.FACTORY_PROJECT_ID) return process.env.FACTORY_PROJECT_ID;
  const found = await findProject({ owner, title });
  if (!found) {
    throw new Error(
      `Could not find Project v2 board "${title ?? DEFAULT_PROJECT_TITLE}"` +
        (owner ? ` under ${owner}` : "") +
        ". Run scripts/setup-factory-board.sh first.",
    );
  }
  return found.projectId;
}

export async function getStatusFieldMeta(projectId) {
  if (!projectId) throw new Error("getStatusFieldMeta requires projectId");
  const raw = await runGh([
    "api",
    "graphql",
    "-f",
    `query=query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }`,
    "-f",
    `projectId=${projectId}`,
  ]);
  const data = JSON.parse(raw);
  const fields = data?.data?.node?.fields?.nodes ?? [];
  const statusField = fields.find(
    (f) => f?.__typename === "ProjectV2SingleSelectField" && f?.name === "Status",
  );
  if (!statusField) {
    throw new Error(`Project ${projectId} has no single-select field named "Status"`);
  }
  const options = Array.isArray(statusField.options) ? statusField.options : [];
  const optionsByName = {};
  for (const o of options) {
    if (o?.name) optionsByName[o.name] = o.id;
  }
  return {
    statusFieldId: statusField.id,
    options,
    optionsByName,
  };
}

// Pure: shape ProjectV2 item nodes into the compact form the agent consumes.
// Issues that don't have a Status set yet are dropped — the factory only
// cares about items the human has placed on the board.
export function shapeItems(nodes, { statusName, repo } = {}) {
  const wantStatus = typeof statusName === "string" ? statusName.toLowerCase() : null;
  const wantRepo = typeof repo === "string" && repo.length > 0 ? repo.toLowerCase() : null;
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node) continue;
    const content = node.content;
    if (!content || content.__typename !== "Issue") continue;
    const number = content.number;
    if (!Number.isInteger(number)) continue;
    const repoNwo = content.repository?.nameWithOwner ?? "";
    if (wantRepo && repoNwo.toLowerCase() !== wantRepo) continue;
    const status = extractStatus(node.fieldValues?.nodes);
    if (wantStatus && (status ?? "").toLowerCase() !== wantStatus) continue;
    out.push({
      itemId: node.id,
      contentId: content.id ?? null,
      issueNumber: number,
      title: content.title ?? "",
      url: content.url ?? "",
      issueState: content.state ?? null,
      status,
      labels: (content.labels?.nodes ?? [])
        .map((l) => (typeof l?.name === "string" ? l.name : null))
        .filter(Boolean),
      repoNameWithOwner: repoNwo,
    });
  }
  return out;
}

function extractStatus(fieldValues) {
  if (!Array.isArray(fieldValues)) return null;
  for (const fv of fieldValues) {
    if (fv?.__typename !== "ProjectV2ItemFieldSingleSelectValue") continue;
    const name = fv.field?.name;
    if (name !== "Status") continue;
    return typeof fv.name === "string" ? fv.name : null;
  }
  return null;
}

const ITEMS_QUERY = `query($projectId: ID!, $cursor: String, $pageSize: Int!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $pageSize, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue {
              id
              number
              title
              url
              state
              repository { nameWithOwner }
              labels(first: 50) { nodes { name } }
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                field { ... on ProjectV2FieldCommon { name } }
                optionId
                name
              }
            }
          }
        }
      }
    }
  }
}`;

export async function queryStatusItems(
  projectId,
  statusName,
  { repo = DEFAULT_REPO, limit = 200 } = {},
) {
  if (!projectId) throw new Error("queryStatusItems requires projectId");
  if (!statusName) throw new Error("queryStatusItems requires statusName");
  const all = [];
  let cursor = null;
  let pages = 0;
  // Hard upper bound on pages — 20 pages × 100 items = 2000 items. The board
  // is unlikely to exceed this for the foreseeable future and stopping early
  // protects against runaway pagination if the schema ever changes shape.
  const MAX_PAGES = 20;
  while (pages < MAX_PAGES) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${ITEMS_QUERY}`,
      "-f",
      `projectId=${projectId}`,
      "-F",
      `pageSize=${ITEMS_PAGE_SIZE}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const raw = await runGh(args);
    const data = JSON.parse(raw);
    const items = data?.data?.node?.items;
    const nodes = items?.nodes ?? [];
    all.push(...shapeItems(nodes, { statusName, repo }));
    if (all.length >= limit) break;
    if (!items?.pageInfo?.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
    pages++;
  }
  return all.slice(0, limit);
}

const SET_STATUS_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

export async function setItemStatus({ projectId, itemId, statusFieldId, optionId }) {
  if (!projectId || !itemId || !statusFieldId || !optionId) {
    throw new Error("setItemStatus requires projectId, itemId, statusFieldId, optionId");
  }
  const raw = await runGh([
    "api",
    "graphql",
    "-f",
    `query=${SET_STATUS_MUTATION}`,
    "-f",
    `projectId=${projectId}`,
    "-f",
    `itemId=${itemId}`,
    "-f",
    `fieldId=${statusFieldId}`,
    "-f",
    `optionId=${optionId}`,
  ]);
  const data = JSON.parse(raw);
  if (data?.errors?.length) {
    throw new Error(`setItemStatus failed: ${JSON.stringify(data.errors)}`);
  }
  return data?.data?.updateProjectV2ItemFieldValue?.projectV2Item ?? null;
}

const _metaCache = new Map();
export function _clearMetaCacheForTests() {
  _metaCache.clear();
}

export async function setItemStatusByName({ projectId, itemId, statusName }) {
  if (!projectId || !itemId || !statusName) {
    throw new Error("setItemStatusByName requires projectId, itemId, statusName");
  }
  let meta = _metaCache.get(projectId);
  if (!meta) {
    meta = await getStatusFieldMeta(projectId);
    _metaCache.set(projectId, meta);
  }
  const optionId = meta.optionsByName[statusName];
  if (!optionId) {
    throw new Error(
      `Status "${statusName}" not found on project ${projectId}. ` +
        `Available: ${Object.keys(meta.optionsByName).join(", ")}`,
    );
  }
  return setItemStatus({
    projectId,
    itemId,
    statusFieldId: meta.statusFieldId,
    optionId,
  });
}

export async function hasStatusOption(projectId, name) {
  if (!name) throw new Error("hasStatusOption requires an option name");
  const meta = await getStatusFieldMeta(projectId);
  return Object.prototype.hasOwnProperty.call(meta.optionsByName, name);
}

// Pure: shape item nodes from EXPORT_QUERY into the backup rows. Unlike
// shapeItems this keeps every item (any repo, PRs, drafts, no Status) — a
// migration that clears a Status clears it on all of them.
export function shapeStatusExport(nodes) {
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node?.id) continue;
    const content = node.content ?? null;
    const number = Number.isInteger(content?.number) ? content.number : null;
    const status = node.status;
    out.push({
      itemId: node.id,
      issueNumber: number,
      status:
        status?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
        typeof status.name === "string"
          ? status.name
          : null,
      type: content?.__typename ?? null,
    });
  }
  return out;
}

function compareExportRows(a, b) {
  // Numbered items first, ascending; then itemId, so the order is stable
  // across exports however the board was re-sorted in between.
  if (a.issueNumber !== b.issueNumber) {
    if (a.issueNumber === null) return 1;
    if (b.issueNumber === null) return -1;
    return a.issueNumber - b.issueNumber;
  }
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

// The Status is read by field name, not from a fieldValues(first: N) page: a
// backup can't afford to miss a Status that sits past the first N values.
const EXPORT_QUERY = `query($projectId: ID!, $cursor: String, $pageSize: Int!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: $pageSize, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue { number }
            ... on PullRequest { number }
          }
          status: fieldValueByName(name: "Status") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
          }
        }
      }
    }
  }
}`;

// 50 pages × 100 items. A backup must be complete, so running past the cap
// throws instead of returning a silently truncated list.
const EXPORT_MAX_PAGES = 50;

export async function exportStatuses(projectId) {
  if (!projectId) throw new Error("exportStatuses requires projectId");
  const all = [];
  let cursor = null;
  for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${EXPORT_QUERY}`,
      "-f",
      `projectId=${projectId}`,
      "-F",
      `pageSize=${ITEMS_PAGE_SIZE}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const data = JSON.parse(await runGh(args));
    if (data?.errors?.length) {
      throw new Error(`exportStatuses failed: ${JSON.stringify(data.errors)}`);
    }
    const items = data?.data?.node?.items;
    if (!items) throw new Error(`Project ${projectId} returned no items connection`);
    all.push(...shapeStatusExport(items.nodes));
    if (!items.pageInfo?.hasNextPage) return all.sort(compareExportRows);
    cursor = items.pageInfo.endCursor;
  }
  throw new Error(
    `exportStatuses: board has more than ${EXPORT_MAX_PAGES * ITEMS_PAGE_SIZE} items; ` +
      "refusing to return an incomplete backup",
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(argv) {
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  switch (sub) {
    case "find-project":
      return findProject({
        owner: flags.owner,
        title: flags.title ?? DEFAULT_PROJECT_TITLE,
      });
    case "get-status-meta": {
      const projectId = await resolveProjectId({
        projectId: flags["project-id"],
        owner: flags.owner,
        title: flags.title,
      });
      return getStatusFieldMeta(projectId);
    }
    case "has-status-option": {
      if (!flags.name) throw new Error("has-status-option requires --name <option>");
      const projectId = await resolveProjectId({
        projectId: flags["project-id"],
        owner: flags.owner,
        title: flags.title,
      });
      const present = await hasStatusOption(projectId, flags.name);
      if (!present) process.exitCode = 1;
      return { name: flags.name, present };
    }
    case "export-statuses": {
      const projectId = await resolveProjectId({
        projectId: flags["project-id"],
        owner: flags.owner,
        title: flags.title,
      });
      return exportStatuses(projectId);
    }
    case "query-status-items": {
      if (!flags.status) throw new Error("query-status-items requires --status <name>");
      const projectId = await resolveProjectId({
        projectId: flags["project-id"],
        owner: flags.owner,
        title: flags.title,
      });
      return queryStatusItems(projectId, flags.status, {
        repo: flags.repo ?? DEFAULT_REPO,
        limit: Number(flags.limit ?? 200),
      });
    }
    case "set-status": {
      if (!flags["item-id"]) throw new Error("set-status requires --item-id <id>");
      if (!flags.status) throw new Error("set-status requires --status <name>");
      const projectId = await resolveProjectId({
        projectId: flags["project-id"],
        owner: flags.owner,
        title: flags.title,
      });
      return setItemStatusByName({
        projectId,
        itemId: flags["item-id"],
        statusName: flags.status,
      });
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: factory-project.mjs <find-project [--owner <login>] [--title <title>]|" +
          "get-status-meta [--project-id <id>] [--owner <login>] [--title <title>]|" +
          "has-status-option --name <option> [--project-id <id>] [--owner <login>] [--title <title>]|" +
          "export-statuses [--project-id <id>] [--owner <login>] [--title <title>]|" +
          "query-status-items --status <name> [--project-id <id>] [--owner <login>] [--title <title>] [--repo <owner/name>] [--limit <n>]|" +
          "set-status --item-id <id> --status <name> [--project-id <id>] [--owner <login>] [--title <title>]>\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out === null || out === undefined) return;
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
