import { expect, type Locator } from "@playwright/test";

/** What a password field shows once `fillSecret` has entered the real value. */
export const SECRET_STAND_IN = "hidden-by-fillSecret";

/**
 * Enter a password into a React-controlled input without it reaching the
 * Playwright report, which CI uploads as an artifact of a public repo
 * (scripts/scan-playwright-report.mjs withholds the upload if one gets in;
 * see ADR-0056).
 *
 * The report would get it two ways. `locator.fill()` titles its step
 * `Fill "<value>"`. And a failing assertion, or a failure anywhere else,
 * saves the page's ARIA snapshot, which lists an input's value.
 *
 * So the value is set through the native setter and the `input` event React
 * listens for is fired, which puts it in the component's state and records
 * the step as a bare "Evaluate". In the same synchronous call, the input is
 * swapped for a copy showing SECRET_STAND_IN. The form submits from React
 * state, so the login still works, and React keeps updating the detached
 * original, so a re-render can't bring the value back. A form that reads the
 * DOM instead (FormData, a server action) would submit the stand-in and fail.
 *
 * Only for `type="password"` fields: on an email or patterned field the
 * stand-in would fail native validation and the form would never submit.
 * Call it once per field; after the swap the field no longer feeds React.
 */
export async function fillSecret(input: Locator, value: string): Promise<void> {
  // fill() waits for this itself; evaluate() only waits for the element.
  await expect(input).toBeEditable();
  await input.evaluate(
    (element, { secret, standIn }) => {
      const field = element as HTMLInputElement;
      if (field.type !== "password") {
        throw new Error(`fillSecret is for password fields, not type="${field.type}"`);
      }
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setValue) throw new Error("HTMLInputElement has no value setter");
      setValue.call(field, secret);
      field.dispatchEvent(new Event("input", { bubbles: true }));

      const copy = field.cloneNode(false) as HTMLInputElement;
      copy.removeAttribute("value");
      copy.value = standIn; // a cloned input would otherwise copy the secret
      field.replaceWith(copy);
    },
    { secret: value, standIn: SECRET_STAND_IN },
  );
}
