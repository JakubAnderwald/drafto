import { test, expect } from "./helpers/test";

test.describe("Dropdown menus", () => {
  // Issue #480: the trigger's mousedown used to count as an outside click, so the menu closed
  // and the trigger's click opened it again. The trigger could never close its own menu.
  test("a second click on the app-menu trigger closes the menu", async ({ page }) => {
    await page.goto("/");

    const trigger = page.getByTestId("app-menu-trigger");
    const settingsItem = page.getByTestId("settings-button");

    await trigger.click();
    await expect(settingsItem).toBeVisible();

    await trigger.click();
    await expect(settingsItem).toBeHidden();

    // It opens again on the next click, and Escape still closes it.
    await trigger.click();
    await expect(settingsItem).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settingsItem).toBeHidden();
  });
});
