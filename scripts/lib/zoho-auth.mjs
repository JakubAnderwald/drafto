// OAuth refresh-token helper for the Zoho Mail REST API.
//
// Reads ~/drafto-secrets/zoho-oauth.json (the file produced by
// setup-zoho-oauth.mjs) and trades the long-lived refresh_token for
// short-lived (1h) access_tokens via accounts.zoho.<dc>/oauth/v2/token.
//
// Tokens are cached in-process. zoho-cli.mjs calls invalidate() when it sees
// an INVALID_OAUTHTOKEN response from the API, then retries exactly once.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_OAUTH_PATH =
  process.env.ZOHO_OAUTH_PATH ?? path.join(os.homedir(), "drafto-secrets", "zoho-oauth.json");

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
}

export async function loadConfig(filePath = DEFAULT_OAUTH_PATH) {
  if (cached.config) return cached.config;
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

export async function getAccessToken() {
  if (cached.token && Date.now() < cached.token.expiresAt - 30_000) {
    return cached.token.value;
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
  return cached.token.value;
}

export function invalidateAccessToken() {
  cached.token = null;
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
