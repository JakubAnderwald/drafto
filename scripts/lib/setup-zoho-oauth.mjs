#!/usr/bin/env node
// One-time interactive setup for the Zoho OAuth refresh token used by the
// real-time support agent.
//
// Walks the operator through:
//   1. Creating a NEW "Self Client" app at https://api-console.zoho.eu/
//      (do NOT reuse the test client `1000.1WE9804R1QYUL3MHUF578XC2ZR554F`
//      used during planning).
//   2. Generating a 10-minute grant code for scopes
//        ZohoMail.accounts.READ,ZohoMail.messages.ALL,ZohoMail.folders.ALL
//   3. Pasting client_id, client_secret, and grant code into the prompt.
//
// The script exchanges the grant code at accounts.zoho.<dc>/oauth/v2/token,
// fetches the account_id via GET /api/accounts, and writes
// ~/drafto-secrets/zoho-oauth.json with {client_id, client_secret,
// refresh_token, account_id, primary_email, datacenter}, perms 0600.
//
// Re-run this script if the refresh token is ever revoked or the Self Client
// app is deleted.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const DEFAULT_OUT = path.join(os.homedir(), "drafto-secrets", "zoho-oauth.json");

const DATACENTER_HOSTS = {
  eu: { accounts: "accounts.zoho.eu", mail: "mail.zoho.eu" },
  com: { accounts: "accounts.zoho.com", mail: "mail.zoho.com" },
  in: { accounts: "accounts.zoho.in", mail: "mail.zoho.in" },
  au: { accounts: "accounts.zoho.com.au", mail: "mail.zoho.com.au" },
  jp: { accounts: "accounts.zoho.jp", mail: "mail.zoho.jp" },
};

async function ask(rl, question, fallback) {
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    process.stdout.write(
      [
        "",
        "Drafto support-agent — Zoho OAuth setup",
        "----------------------------------------",
        "",
        "Before continuing:",
        "  1. Open https://api-console.zoho.eu/ (or your data centre's console).",
        "  2. Create a new Self Client app for the support agent.",
        "  3. Generate a grant code with all three scopes:",
        "       ZohoMail.accounts.READ,ZohoMail.messages.ALL,ZohoMail.folders.ALL",
        "     and a 10-minute lifetime. Copy it now — it expires fast.",
        "",
      ].join("\n") + "\n",
    );

    const datacenter = (await ask(rl, "Data centre [eu]: ", "eu")).toLowerCase();
    const hosts = DATACENTER_HOSTS[datacenter];
    if (!hosts) throw new Error(`Unknown datacenter: ${datacenter}`);

    const clientId = await ask(rl, "Client ID: ", "");
    const clientSecret = await ask(rl, "Client secret: ", "");
    const grantCode = await ask(rl, "Grant code: ", "");
    if (!clientId || !clientSecret || !grantCode) {
      throw new Error("client_id, client_secret, and grant code are all required");
    }
    const primaryEmail = await ask(
      rl,
      "Primary email of the OAuth user [support@drafto.eu]: ",
      "support@drafto.eu",
    );
    const outPath = await ask(rl, `Output path [${DEFAULT_OUT}]: `, DEFAULT_OUT);

    process.stdout.write("\nExchanging grant code for refresh token...\n");
    const tokenRes = await fetch(`https://${hosts.accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: grantCode,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
      }).toString(),
    });
    const tokenBody = await tokenRes.json();
    if (!tokenRes.ok || !tokenBody.refresh_token) {
      throw new Error(
        `OAuth exchange failed (status=${tokenRes.status}): ${JSON.stringify(tokenBody)}`,
      );
    }

    process.stdout.write("Fetching account_id...\n");
    const accountsRes = await fetch(`https://${hosts.mail}/api/accounts`, {
      headers: { Authorization: `Zoho-oauthtoken ${tokenBody.access_token}` },
    });
    const accountsBody = await accountsRes.json();
    if (!accountsRes.ok) {
      throw new Error(
        `/api/accounts failed: ${accountsRes.status} ${JSON.stringify(accountsBody)}`,
      );
    }
    const accounts = accountsBody.data ?? accountsBody.accounts ?? [];
    const account =
      accounts.find(
        (a) =>
          (a.primaryEmailAddress ?? a.primary_email ?? "").toLowerCase() ===
          primaryEmail.toLowerCase(),
      ) ?? accounts[0];
    if (!account) throw new Error(`No accounts returned for ${primaryEmail}`);
    const accountId = String(account.accountId ?? account.account_id ?? account.id);

    const outDir = path.dirname(outPath);
    await fs.mkdir(outDir, { recursive: true });
    const config = {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenBody.refresh_token,
      account_id: accountId,
      primary_email: primaryEmail,
      datacenter,
    };
    await fs.writeFile(outPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(outPath, 0o600);
    process.stdout.write(`\nWrote ${outPath} (mode 0600). account_id=${accountId}.\n`);
    process.stdout.write("Done. The agent can now run.\n");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exit(1);
});
