// Signup a fresh test user on https://drafto.eu via the public UI.
// Writes /tmp/e2e-approval/state.json with testEmail + testUserId for
// downstream scripts to pick up.
//
// Usage: node 01-signup.mjs
// Requires: Playwright's chromium installed (`pnpm exec playwright install chromium`)

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = "/tmp/e2e-approval";
fs.mkdirSync(STATE_DIR, { recursive: true });

const stamp = Date.now();
const testEmail = `jakub+draftoe2e-${stamp}@anderwald.info`;
const testPassword = `Regression-${stamp}-pw`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const signupResponses = [];
page.on("response", async (resp) => {
  if (resp.url().includes("/auth/v1/signup")) {
    const body = await resp.text().catch(() => "");
    signupResponses.push({
      status: resp.status(),
      body: body.slice(0, 800),
    });
  }
});

await page.goto("https://drafto.eu/signup", { waitUntil: "networkidle", timeout: 45000 });
await page.waitForSelector("#email", { timeout: 15000 });
await page.locator("#email").fill(testEmail);
await page.locator("#password").fill(testPassword);
await page.locator("form").evaluate((f) => f.requestSubmit());

await Promise.race([
  page.waitForURL(/waiting-for-approval|login/, { timeout: 20000 }).catch(() => null),
  page.waitForTimeout(20000),
]);
await page.waitForTimeout(2000);

const finalUrl = page.url();
await browser.close();

if (signupResponses.length === 0) {
  console.error("FAIL: no POST to /auth/v1/signup was observed");
  process.exit(1);
}
const last = signupResponses[signupResponses.length - 1];
if (last.status !== 200) {
  console.error(`FAIL: signup returned ${last.status}\n${last.body}`);
  process.exit(1);
}

let testUserId;
try {
  const parsed = JSON.parse(last.body);
  testUserId = parsed?.id ?? parsed?.user?.id;
} catch {
  console.error(`FAIL: could not parse signup response body:\n${last.body}`);
  process.exit(1);
}
if (typeof testUserId !== "string" || testUserId.length === 0) {
  console.error(
    `FAIL: signup response did not contain a user id (neither .id nor .user.id):\n${last.body}`,
  );
  process.exit(1);
}

const state = {
  testEmail,
  testPassword,
  testUserId,
  finalUrl,
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(STATE_DIR, "state.json"), JSON.stringify(state, null, 2));
console.log(`OK signup`);
console.log(`  testEmail=${testEmail}`);
console.log(`  testUserId=${testUserId}`);
console.log(`  finalUrl=${finalUrl}`);
