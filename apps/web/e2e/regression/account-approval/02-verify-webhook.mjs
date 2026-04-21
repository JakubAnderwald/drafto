// Verify that the new-signup webhook fired successfully.
// Polls auth.users + profiles for the new row, then net._http_response
// for a 200 from the webhook.
//
// Usage: node 02-verify-webhook.mjs
// Requires: `supabase link --project-ref tbmjbxxseonkciqovnpl` (prod) already done.

import fs from "node:fs";
import { execSync } from "node:child_process";

const state = JSON.parse(fs.readFileSync("/tmp/e2e-approval/state.json", "utf8"));

function sbQuery(sql) {
  const raw = execSync(`supabase db query --linked --output json ${JSON.stringify(sql)}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  // supabase CLI emits a JSON envelope with rows[]; strip stderr warnings
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) throw new Error(`unexpected CLI output:\n${raw}`);
  return JSON.parse(raw.slice(jsonStart)).rows ?? [];
}

async function pollUntil(label, predicate, attempts = 15, delayMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    const result = predicate();
    if (result) return result;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const startedAt = new Date(state.createdAt).toISOString();

// 1. profile row auto-created
const profileRow = await pollUntil("profiles row for test user", () => {
  const rows = sbQuery(
    `select id, is_approved from public.profiles where id = '${state.testUserId}';`,
  );
  return rows[0] ?? null;
});
if (profileRow.is_approved !== false) {
  console.error(`FAIL: profile already is_approved=true (should be false)`);
  process.exit(1);
}
console.log("OK profile row created with is_approved=false");

// 2. webhook response in pg_net
const webhookResp = await pollUntil(
  "pg_net webhook response",
  () => {
    const rows = sbQuery(
      `select status_code, substring(content, 1, 200) as body
       from net._http_response
       where created > '${startedAt}'::timestamptz
       order by created desc
       limit 1;`,
    );
    return rows[0] ?? null;
  },
  20,
);

if (webhookResp.status_code !== 200) {
  console.error(`FAIL: webhook returned ${webhookResp.status_code}\n  body: ${webhookResp.body}`);
  process.exit(1);
}
if (!webhookResp.body?.includes('"emailSent":true')) {
  console.error(`FAIL: webhook body did not indicate emailSent=true\n  body: ${webhookResp.body}`);
  process.exit(1);
}
console.log(`OK webhook returned 200 with emailSent=true`);
console.log("");
console.log("Now check Gmail (via Claude Code): admin notification should be in your inbox.");
console.log(`  Search query: from:hello@drafto.eu subject:"New Drafto signup" newer_than:10m`);
console.log(
  `  Expected recipient: jakub@anderwald.info (plus test user ${state.testEmail} got the Supabase confirmation email)`,
);
