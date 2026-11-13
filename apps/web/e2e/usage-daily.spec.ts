import { createClient } from "@supabase/supabase-js";
import type { Page, Request } from "@playwright/test";
import type { Database } from "@drafto/shared";
import { assertNotProduction } from "./helpers/e2e-supabase";
import { test, expect } from "./helpers/test";

/**
 * The web activity-day ping (ADR 0078): opening the signed-in app sends today's UTC day
 * to `record_activity` once per browser session, and the server keeps a `usage_daily`
 * row for (E2E user, today, 'web').
 *
 * Needs `record_activity` on the dev project, i.e. the usage_daily migration applied there.
 * The row check reads `usage_daily` with the service-role key (the table has no RLS policies,
 * so the E2E user can't read it). CI sets that key on `main` runs only, so pull-request
 * runs check the request and its 2xx, and skip the row check.
 */

const RECORD_ACTIVITY_PATH = "/rest/v1/rpc/record_activity";
/** sessionStorage key the ping writes once the server accepted the day (use-activity-ping.ts). */
const ACTIVITY_DAY_STORAGE_KEY = "drafto:activity-day";
/** How long a reload gets to (wrongly) send the day again. */
const NO_REPEAT_WINDOW_MS = 3_000;

interface RecordActivityBody {
  p_days: string[];
  p_client: string;
}

function isRecordActivity(request: Request): boolean {
  return request.method() === "POST" && new URL(request.url()).pathname === RECORD_ACTIVITY_PATH;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Opens the app and returns the day its ping sent, after checking the request and response. */
async function openAppAndCatchPing(page: Page): Promise<string> {
  const dayBefore = utcToday();
  const pinged = page.waitForRequest(isRecordActivity, { timeout: 15_000 });
  await page.goto("/");
  const request = await pinged;
  const dayAfter = utcToday();

  const body = request.postDataJSON() as RecordActivityBody;
  expect(body.p_client).toBe("web");
  expect(body.p_days).toHaveLength(1);
  // Normally both are today; around midnight UTC either is right.
  expect([dayBefore, dayAfter]).toContain(body.p_days[0]);

  const response = await request.response();
  expect(response, "record_activity got no response").not.toBeNull();
  expect(response?.ok(), `record_activity returned ${response?.status()}`).toBe(true);

  return body.p_days[0];
}

test.describe("Activity day ping", () => {
  test("opening the app records today once per browser session", async ({ page }) => {
    let pings = 0;
    page.on("request", (request) => {
      if (isRecordActivity(request)) pings += 1;
    });

    const day = await openAppAndCatchPing(page);
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();

    // The day is marked only after the server accepted it; wait for that before reloading.
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), ACTIVITY_DAY_STORAGE_KEY))
      .toMatch(new RegExp(`:${day}$`));
    expect(pings).toBe(1);

    // Same tab, same session: a reload must not send the day again.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Notebooks" })).toBeVisible();
    await page.waitForTimeout(NO_REPEAT_WINDOW_MS);

    if (utcToday() !== day) {
      test.info().annotations.push({
        type: "note",
        description: "The UTC day changed during the test, so a second ping was allowed.",
      });
      return;
    }
    expect(pings).toBe(1);
  });

  test("opening the app leaves today's web row for the E2E user", async ({ page, e2eSession }) => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    test.skip(
      !supabaseUrl || !serviceRoleKey,
      "SUPABASE_SERVICE_ROLE_KEY is not set (CI sets it on main runs only); the request itself is checked by the test above",
    );
    if (!supabaseUrl || !serviceRoleKey) return;
    assertNotProduction(supabaseUrl);

    const day = await openAppAndCatchPing(page);
    const { userId } = await e2eSession.get();

    const admin = createClient<Database>(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-drafto-client": "web-e2e" } },
    });
    const { data, error } = await admin
      .from("usage_daily")
      .select("user_id, day, client")
      .eq("user_id", userId)
      .eq("day", day)
      .eq("client", "web");

    expect(error).toBeNull();
    expect(data).toEqual([{ user_id: userId, day, client: "web" }]);
  });
});
