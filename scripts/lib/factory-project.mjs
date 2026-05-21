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
// CLI (called from scripts/factory-agent.sh):
//   find-project [--owner <login>] [--title <title>]
//   get-status-meta [--project-id <id>] [--owner <login>] [--title <title>]
//   query-status-items --status <name> [--project-id <id>]
//                      [--owner <login>] [--title <title>]
//                      [--repo <owner/name>] [--limit <n>]
//   set-status --item-id <id> --status <name> [--project-id <id>]
//              [--owner <login>] [--title <title>]
//
// All subcommands print JSON to stdout and exit 0; errors print
// `{"error": "..."}` to stderr and exit non-zero — same shape as
// github-sync.mjs / state-cli.mjs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
      const opts = { maxBuffer: 16 * 1024 * 1024 };
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
