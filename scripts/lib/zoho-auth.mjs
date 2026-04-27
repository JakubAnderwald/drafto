// OAuth refresh-token helper for the Zoho Mail REST API.
//
// Reads ~/drafto-secrets/zoho-oauth.json (the file produced by
// setup-zoho-oauth.mjs) and trades the long-lived refresh_token for
// short-lived (1h) access_tokens via accounts.zoho.<dc>/oauth/v2/token.
//
// Tokens are cached in two layers:
//   1. In-process (memory) — primary cache for repeated calls inside a single
//      Node process.
//   2. On disk at <oauth-dir>/zoho-token-cache.json (mode 0600) — survives
//      across the multiple short-lived `node scripts/lib/zoho-cli.mjs ...`
//      invocations that support-agent.sh fires per run. Without this, every
//      launchd interval would burn 5+ OAuth refreshes (one per CLI call) and
//      hit Zoho's "too many requests" cap.
//
// zoho-cli.mjs calls invalidate() when it sees an INVALID_OAUTHTOKEN response
// from the API, then retries exactly once. invalidate() clears both caches.

import { promises as fs, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_OAUTH_PATH =
  process.env.ZOHO_OAUTH_PATH ?? path.join(os.homedir(), "drafto-secrets", "zoho-oauth.json");

function defaultTokenCachePath() {
  return (
    process.env.ZOHO_TOKEN_CACHE_PATH ??
    path.join(path.dirname(DEFAULT_OAUTH_PATH), "zoho-token-cache.json")
  );
}

const DATACENTER_HOSTS = {
  eu: { accounts: "accounts.zoho.eu", mail: "mail.zoho.eu" },
  com: { accounts: "accounts.zoho.com", mail: "mail.zoho.com" },
  in: { accounts: "accounts.zoho.in", mail: "mail.zoho.in" },
  au: { accounts: "accounts.zoho.com.au", mail: "mail.zoho.com.au" },
  jp: { accounts: "accounts.zoho.jp", mail: "mail.zoho.jp" },
};

let cached = { config: null, token: null, fetchImpl: globalThis.fetch };

export function _resetForTests({ fetchImpl } = {}) {
  cached = { config: null, token: null, fetchImpl: fetchImpl ?? globalThis.fetch };
  // Tests share TMP_DIR across cases; without this the disk-cached token from
  // one test would leak into the next and skip the expected refresh.
  deleteTokenFromDiskSync();
}

export async function loadConfig(filePath = DEFAULT_OAUTH_PATH) {
  if (cached.config) return cached.config;
  // setup-zoho-oauth.mjs writes this file with mode 0600. If it ever drifts
  // (cp without -p, restored from a backup with a permissive umask, etc.) the
  // long-lived refresh_token + client_secret would be readable by other local
  // users — fail loudly rather than silently load it.
  const stat = await fs.stat(filePath);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `${filePath} is group/world-readable (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it.`,
    );
  }
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const required = ["client_id", "client_secret", "refresh_token", "account_id", "primary_email"];
  for (const key of required) {
    if (!parsed[key]) throw new Error(`zoho-oauth.json missing required field: ${key}`);
  }
  const datacenter = (parsed.datacenter ?? "eu").toLowerCase();
  const hosts = DATACENTER_HOSTS[datacenter];
  if (!hosts) throw new Error(`Unknown Zoho datacenter: ${datacenter}`);
  cached.config = {
    clientId: parsed.client_id,
    clientSecret: parsed.client_secret,
    refreshToken: parsed.refresh_token,
    accountId: parsed.account_id,
    primaryEmail: parsed.primary_email,
    datacenter,
    accountsHost: hosts.accounts,
    mailHost: hosts.mail,
  };
  return cached.config;
}

// 30s safety buffer so we don't hand back a token that expires mid-request.
const TOKEN_SAFETY_MS = 30_000;

function tokenStillValid(t) {
  return t && typeof t.value === "string" && Date.now() < t.expiresAt - TOKEN_SAFETY_MS;
}

async function readTokenFromDisk() {
  const file = defaultTokenCachePath();
  try {
    const stat = await fs.stat(file);
    if ((stat.mode & 0o077) !== 0) {
      // Permissions drifted — refuse and force a refresh + rewrite.
      return null;
    }
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.value !== "string" || typeof parsed?.expiresAt !== "number") return null;
    return { value: parsed.value, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

async function writeTokenToDisk(token) {
  const file = defaultTokenCachePath();
  const tmp = `${file}.${process.pid}.tmp`;
  // The cache dir may not exist when ZOHO_TOKEN_CACHE_PATH overrides the
  // default to a fresh location (per-app cache, tmpfs, CI runner). Without
  // this, every refresh silently fails to persist and the script keeps
  // burning OAuth refreshes on each launchd interval.
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic write: open with 0600 so the tmp file is never world/group-readable
  // even momentarily; then rename into place.
  await fs.writeFile(tmp, JSON.stringify(token), { mode: 0o600 });
  // Some filesystems / umasks ignore the mode flag — chmod explicitly.
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

function deleteTokenFromDiskSync() {
  // Sync so invalidateAccessToken() — which is called right before a retry —
  // takes effect before the next read. An async delete would race the retry's
  // readTokenFromDisk() and let the dead token come back through the disk.
  try {
    unlinkSync(defaultTokenCachePath());
  } catch {
    /* swallow — file may not exist */
  }
}

export async function getAccessToken() {
  if (tokenStillValid(cached.token)) return cached.token.value;
  // Try the on-disk cache before refreshing — this is what saves us from
  // hammering accounts.zoho.eu when support-agent.sh invokes node multiple
  // times per launchd interval.
  const disk = await readTokenFromDisk();
  if (tokenStillValid(disk)) {
    cached.token = disk;
    return disk.value;
  }
  const cfg = await loadConfig();
  const params = new URLSearchParams({
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
  });
  const res = await cached.fetchImpl(`https://${cfg.accountsHost}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zoho OAuth refresh failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`Zoho OAuth refresh returned no access_token: ${JSON.stringify(body)}`);
  }
  const expiresInMs = (body.expires_in ?? 3600) * 1000;
  cached.token = { value: body.access_token, expiresAt: Date.now() + expiresInMs };
  // Persist to disk best-effort. If the write fails (permissions, full disk),
  // log nothing — the in-memory token still works for this process and the
  // next process will simply refresh again.
  try {
    await writeTokenToDisk(cached.token);
  } catch {
    /* swallow — disk cache is optional */
  }
  return cached.token.value;
}

export function invalidateAccessToken() {
  cached.token = null;
  // Drop the disk copy too so the next call doesn't return the same dead
  // token from disk and immediately 401 again.
  deleteTokenFromDiskSync();
}

export async function getMailHost() {
  return (await loadConfig()).mailHost;
}

export async function getAccountId() {
  return (await loadConfig()).accountId;
}

export async function getPrimaryEmail() {
  return (await loadConfig()).primaryEmail;
}
