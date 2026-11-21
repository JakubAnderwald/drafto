import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Database } from "@drafto/shared";
import { ACCOUNT_INACTIVE_TITLE } from "@drafto/shared/constants";
import { ADMIN_E2E_SKIP_REASON, getAdminCredentials } from "./helpers/admin-credentials";
import { assertNotProduction } from "./helpers/e2e-supabase";
import { fillSecret } from "./helpers/secret-fields";

/**
 * Open signup with admin suspend (ADR 0094): an admin suspends an active account on /admin,
 * the account lands on the "Account not active" screen and its API calls are refused, and
 * Activate gives it its notes back.
 *
 * Runs in the `chromium-admin` project (the file name matches its `admin.spec.ts` pattern),
 * which is only registered when E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and
 * SUPABASE_SERVICE_ROLE_KEY are set; the skip below covers running it some other way. It
 * creates its own user with the dev project's service-role key, so the shared E2E user is
 * never suspended, and afterAll deletes it.
 */
const hasAdminCredentials = getAdminCredentials() !== null;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const canRun = hasAdminCredentials && supabaseUrl !== "" && serviceRoleKey !== "";
const SKIP_REASON = `${ADMIN_E2E_SKIP_REASON}, or NEXT_PUBLIC_SUPABASE_URL is missing`;

interface SuspendUser {
  id: string;
  email: string;
  password: string;
}

function serviceRoleClient(): SupabaseClient<Database> {
  assertNotProduction(supabaseUrl);
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "x-drafto-client": "web-e2e-account-suspend" } },
  });
}

async function createActiveUser(admin: SupabaseClient<Database>): Promise<SuspendUser> {
  const email = `suspend-e2e+${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Could not create the suspend test user: ${error?.message ?? "no user"}`);
  }
  return { id: data.user.id, email, password };
}

async function isActive(admin: SupabaseClient<Database>, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("profiles")
    .select("is_approved")
    .eq("id", userId)
    .single();
  if (error) throw new Error(`Could not read the profile: ${error.message}`);
  return data.is_approved;
}

/** A signed-out browser context for the test user, separate from the admin's session. */
async function userPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

async function signIn(page: Page, user: SuspendUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await fillSecret(page.getByLabel("Password", { exact: true }), user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 });
}

test.describe("Admin suspends and reactivates an account", () => {
  test.skip(!canRun, SKIP_REASON);

  let admin: SupabaseClient<Database>;
  let suspendUser: SuspendUser | null = null;

  test.beforeAll(async () => {
    admin = serviceRoleClient();
    suspendUser = await createActiveUser(admin);
  });

  test.afterAll(async () => {
    if (!suspendUser) return;
    const { error } = await admin.auth.admin.deleteUser(suspendUser.id);
    if (error) console.warn(`[account-suspend e2e] could not delete ${suspendUser.id}:`, error);
  });

  test("a new account starts active, Suspend locks it out, and Activate lets it back in", async ({
    page,
    browser,
  }) => {
    const user = suspendUser;
    if (!user) throw new Error("beforeAll did not create the suspend test user");

    // Open signup: the profile the signup trigger made is active without an admin.
    expect(await isActive(admin, user.id)).toBe(true);

    const member = await userPage(browser);
    await signIn(member, user);
    await expect(member).toHaveURL((url) => url.pathname === "/");

    await page.goto("/admin");
    const activeSection = page.getByTestId("admin-active-accounts");
    const inactiveSection = page.getByTestId("admin-inactive-accounts");
    const activeRow = activeSection.locator("li", { hasText: user.email });
    await expect(activeRow).toBeVisible({ timeout: 10000 });

    // The page is server-rendered: retry until the hydrated button opens its dialog.
    const dialog = page.getByRole("alertdialog", { name: "Suspend user?" });
    await expect(async () => {
      await activeRow.getByRole("button", { name: "Suspend" }).click({ timeout: 1000 });
      await expect(dialog).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await expect(dialog).toContainText(`${user.email} loses access to their notes`);
    await dialog.getByRole("button", { name: "Suspend" }).click();

    const inactiveRow = inactiveSection.locator("li", { hasText: user.email });
    await expect(inactiveRow).toBeVisible({ timeout: 10000 });
    expect(await isActive(admin, user.id)).toBe(false);

    // The suspended account's next page load lands on the inactive screen, and its API
    // calls are refused.
    await member.goto("/");
    await expect(member).toHaveURL(/\/waiting-for-approval/, { timeout: 10000 });
    await expect(member.getByRole("heading", { name: ACCOUNT_INACTIVE_TITLE })).toBeVisible();
    await expect(member.getByText(/support@drafto\.eu/)).toBeVisible();
    const refused = await member.request.get("/api/notebooks");
    expect(refused.status()).toBe(403);

    await inactiveRow.getByRole("button", { name: "Activate" }).click();
    await expect(activeSection.locator("li", { hasText: user.email })).toBeVisible({
      timeout: 10000,
    });
    expect(await isActive(admin, user.id)).toBe(true);

    // Reactivated: the inactive screen sends the account back into the app.
    await member.goto("/waiting-for-approval");
    await expect(member).toHaveURL((url) => url.pathname === "/", { timeout: 10000 });
    const allowed = await member.request.get("/api/notebooks");
    expect(allowed.ok()).toBe(true);

    await member.context().close();
  });
});
