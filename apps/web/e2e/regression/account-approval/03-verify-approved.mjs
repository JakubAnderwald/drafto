// Poll profiles.is_approved until it flips to true, which happens after
// the admin clicks the approve link from the notification email.
//
// Usage: node 03-verify-approved.mjs

import fs from "node:fs";
import { execSync } from "node:child_process";

const state = JSON.parse(fs.readFileSync("/tmp/e2e-approval/state.json", "utf8"));

function sbQuery(sql) {
  const raw = execSync(`supabase db query --linked --output json ${JSON.stringify(sql)}`, {
    encoding: "utf8",
  });
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) throw new Error(`unexpected CLI output:\n${raw}`);
  return JSON.parse(raw.slice(jsonStart)).rows ?? [];
}

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const rows = sbQuery(
    `select is_approved, updated_at from public.profiles where id = '${state.testUserId}';`,
  );
  if (rows[0]?.is_approved === true) {
    console.log(`OK approved at ${rows[0].updated_at}`);
    console.log("");
    console.log("Now check Gmail (via Claude Code):");
    console.log(
      `  Search query: from:hello@drafto.eu subject:"account is approved" newer_than:10m`,
    );
    console.log(`  Expected recipient: ${state.testEmail}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.error("TIMEOUT: is_approved did not flip within 2 min — did the admin click the link?");
process.exit(1);
