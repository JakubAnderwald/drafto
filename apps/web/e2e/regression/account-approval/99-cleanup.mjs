// Delete all regression test users from prod.
//
// Usage: node 99-cleanup.mjs

import { execSync } from "node:child_process";

const raw = execSync(
  `supabase db query --linked --output json "delete from auth.users where email like 'jakub+draftoe2e-%@anderwald.info' returning id, email;"`,
  { encoding: "utf8" },
);
const jsonStart = raw.indexOf("{");
const rows = JSON.parse(raw.slice(jsonStart)).rows ?? [];

console.log(`Deleted ${rows.length} test user(s):`);
for (const r of rows) console.log(`  ${r.email}`);
