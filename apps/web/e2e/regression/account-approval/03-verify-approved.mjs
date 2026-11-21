// Check that the new profile is active straight after signup, with no admin action:
// since open signup (ADR 0094) profiles.is_approved defaults to true. Retries briefly
// in case the profile row is still being written.
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

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const rows = sbQuery(
    `select is_approved, created_at from public.profiles where id = '${state.testUserId}';`,
  );
  if (rows[0]?.is_approved === true) {
    console.log(`OK active from signup (profile created ${rows[0].created_at})`);
    process.exit(0);
  }
  if (rows[0]?.is_approved === false) {
    console.error(
      "FAIL: the new profile is not active. Open signup's default (is_approved = true) is missing.",
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.error("TIMEOUT: no profile row for the test user within 30 s");
process.exit(1);
