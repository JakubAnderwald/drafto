import { describe, expect, it } from "vitest";

import {
  AUTH_GENERIC_ERROR_MESSAGE,
  AUTH_RATE_LIMITED_MESSAGE,
  EMAIL_NOT_CONFIRMED_MESSAGE,
  EMAIL_REQUIRED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  USER_ALREADY_EXISTS_MESSAGE,
  WEAK_PASSWORD_MESSAGE,
  describeAuthError,
  hasFieldErrors,
  isValidEmail,
  oauthQueryParams,
  validateCredentials,
  validateEmailField,
} from "../src/index";

describe("isValidEmail (PrimeTestLab 11035 M-02)", () => {
  it.each([
    "name@example.com",
    "  name@example.com  ",
    "first.last+tag@sub.example.co.uk",
    "o'brien@example.ie",
    "user@xn--bcher-kva.de",
    "user@bücher.de",
    "a@b.io",
  ])("accepts %s", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    ["the report's value, with no @", "planner.com"],
    ["an empty value", ""],
    ["whitespace", "   "],
    ["a missing local part", "@example.com"],
    ["a missing domain", "name@"],
    ["a domain without a dot", "name@localhost"],
    ["two @", "name@@example.com"],
    ["an @ in the domain", "name@exa@mple.com"],
    ["a space inside", "na me@example.com"],
    ["a one-letter top-level domain", "name@example.c"],
    ["a numeric top-level domain", "name@example.123"],
    ["a leading dot", ".name@example.com"],
    ["a trailing dot in the local part", "name.@example.com"],
    ["doubled dots", "na..me@example.com"],
    ["an empty domain label", "name@example..com"],
    ["a label starting with a hyphen", "name@-example.com"],
    ["a trailing dot after the domain", "name@example.com."],
    ["a quoted local part", '"name"@example.com'],
    ["an over-long local part", `${"a".repeat(65)}@example.com`],
  ])("refuses %s", (_case, email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe("validateEmailField", () => {
  it("asks for an address when the field is empty, with the copy flow 06 asserts", () => {
    expect(validateEmailField("  ")).toBe(EMAIL_REQUIRED_MESSAGE);
    expect(EMAIL_REQUIRED_MESSAGE).toBe("Please enter your email address.");
  });

  it("explains a malformed address with an example", () => {
    expect(validateEmailField("planner.com")).toBe(INVALID_EMAIL_MESSAGE);
    expect(INVALID_EMAIL_MESSAGE).toContain("name@example.com");
  });

  it("passes a valid address", () => {
    expect(validateEmailField("name@example.com")).toBeUndefined();
  });
});

describe("validateCredentials (PrimeTestLab 11035 M-02)", () => {
  it("reports the email and password errors together, so one submit shows both", () => {
    const errors = validateCredentials({ email: "planner.com", password: "abc" }, "signup");

    expect(errors).toEqual({
      email: INVALID_EMAIL_MESSAGE,
      password: PASSWORD_TOO_SHORT_MESSAGE,
    });
    expect(hasFieldErrors(errors)).toBe(true);
  });

  it("asks for both fields when the form is empty", () => {
    expect(validateCredentials({ email: "", password: "" }, "signup")).toEqual({
      email: EMAIL_REQUIRED_MESSAGE,
      password: PASSWORD_REQUIRED_MESSAGE,
    });
  });

  it("does not hold a short password against an existing account at log-in", () => {
    expect(validateCredentials({ email: "name@example.com", password: "abc" }, "login")).toEqual(
      {},
    );
  });

  it("is empty for a valid form", () => {
    const errors = validateCredentials(
      { email: "name@example.com", password: "secret123" },
      "signup",
    );
    expect(errors).toEqual({});
    expect(hasFieldErrors(errors)).toBe(false);
  });

  it("keeps the password copy in step with the minimum length", () => {
    expect(PASSWORD_TOO_SHORT_MESSAGE).toBe("Password must be at least 6 characters.");
  });
});

describe("describeAuthError (PrimeTestLab 11035 M-02)", () => {
  it("never shows the raw Supabase format error, and puts it under the email field", () => {
    expect(
      describeAuthError({
        message: "Unable to validate email address: invalid format",
        code: "validation_failed",
        status: 400,
      }),
    ).toEqual({ message: INVALID_EMAIL_MESSAGE, field: "email" });
  });

  it("recognises the format error by message alone", () => {
    expect(
      describeAuthError({ message: "Unable to validate email address: invalid format" }),
    ).toEqual({ message: INVALID_EMAIL_MESSAGE, field: "email" });
  });

  it("puts email_address_invalid under the email field", () => {
    expect(
      describeAuthError({
        message: 'Email address "x@y.zz" is invalid',
        code: "email_address_invalid",
      }),
    ).toEqual({ message: INVALID_EMAIL_MESSAGE, field: "email" });
  });

  it("PrimeTestLab 11035 review: puts an email-only validation_failed under the email field", () => {
    expect(
      describeAuthError({
        message: "Password recovery requires an email",
        code: "validation_failed",
      }),
    ).toEqual({ message: INVALID_EMAIL_MESSAGE, field: "email" });
    expect(
      describeAuthError({
        message: "To signup, please provide your email",
        code: "validation_failed",
      }),
    ).toEqual({ message: INVALID_EMAIL_MESSAGE, field: "email" });
  });

  it("PrimeTestLab 11035 review: puts a password validation_failed under the password field", () => {
    expect(
      describeAuthError({ message: "Signup requires a valid password", code: "validation_failed" }),
    ).toEqual({ message: "Signup requires a valid password", field: "password" });
  });

  it("PrimeTestLab 11035 review: keeps other validation_failed errors in the banner, with their own words", () => {
    const pkce = "code challenge method not supported";
    expect(describeAuthError({ message: pkce, code: "validation_failed" })).toEqual({
      message: pkce,
    });
    const phone = "Only an email address or phone number should be provided on signup.";
    expect(describeAuthError({ message: phone, code: "validation_failed" })).toEqual({
      message: phone,
    });
    expect(describeAuthError({ code: "validation_failed" })).toEqual({
      message: AUTH_GENERIC_ERROR_MESSAGE,
    });
  });

  it("does not say which credential was wrong", () => {
    expect(describeAuthError({ message: "Invalid login credentials" })).toEqual({
      message: INVALID_CREDENTIALS_MESSAGE,
    });
    expect(describeAuthError({ code: "invalid_credentials" })).toEqual({
      message: INVALID_CREDENTIALS_MESSAGE,
    });
  });

  it("puts a weak password under the password field, keeping the server's minimum", () => {
    expect(
      describeAuthError({
        message: "Password should be at least 8 characters.",
        code: "weak_password",
      }),
    ).toEqual({ message: "Password must be at least 8 characters.", field: "password" });
  });

  it("keeps the server's wording for other password rules", () => {
    const message = "Password should contain at least one character of each: abc, 123.";
    expect(describeAuthError({ message, code: "weak_password" })).toEqual({
      message,
      field: "password",
    });
    expect(describeAuthError({ code: "weak_password" })).toEqual({
      message: WEAK_PASSWORD_MESSAGE,
      field: "password",
    });
  });

  it("points an existing account at log-in", () => {
    expect(describeAuthError({ message: "User already registered" })).toEqual({
      message: USER_ALREADY_EXISTS_MESSAGE,
    });
    expect(describeAuthError({ code: "user_already_exists" }).message).toBe(
      USER_ALREADY_EXISTS_MESSAGE,
    );
  });

  it("asks to wait on any rate limit", () => {
    expect(describeAuthError({ code: "over_email_send_rate_limit" }).message).toBe(
      AUTH_RATE_LIMITED_MESSAGE,
    );
    expect(describeAuthError({ code: "over_request_rate_limit" }).message).toBe(
      AUTH_RATE_LIMITED_MESSAGE,
    );
    expect(describeAuthError({ message: "Too many", status: 429 }).message).toBe(
      AUTH_RATE_LIMITED_MESSAGE,
    );
    expect(describeAuthError({ message: "email rate limit exceeded" }).message).toBe(
      AUTH_RATE_LIMITED_MESSAGE,
    );
  });

  it("explains an unconfirmed address", () => {
    expect(describeAuthError({ message: "Email not confirmed" })).toEqual({
      message: EMAIL_NOT_CONFIRMED_MESSAGE,
    });
  });

  it("keeps an unknown error's own message", () => {
    expect(describeAuthError({ message: "Signups not allowed for this instance" })).toEqual({
      message: "Signups not allowed for this instance",
    });
  });

  it("is never empty", () => {
    expect(describeAuthError(null).message).toBe(AUTH_GENERIC_ERROR_MESSAGE);
    expect(describeAuthError(undefined).message).toBe(AUTH_GENERIC_ERROR_MESSAGE);
    expect(describeAuthError({ message: "  " }).message).toBe(AUTH_GENERIC_ERROR_MESSAGE);
  });

  it("writes every copy as a short, final sentence", () => {
    for (const copy of [
      INVALID_EMAIL_MESSAGE,
      INVALID_CREDENTIALS_MESSAGE,
      USER_ALREADY_EXISTS_MESSAGE,
      EMAIL_NOT_CONFIRMED_MESSAGE,
      AUTH_RATE_LIMITED_MESSAGE,
      WEAK_PASSWORD_MESSAGE,
      AUTH_GENERIC_ERROR_MESSAGE,
    ]) {
      expect(copy.endsWith(".")).toBe(true);
      expect(copy.length).toBeLessThan(80);
    }
  });
});

describe("oauthQueryParams (PrimeTestLab 11035 M-03)", () => {
  it("makes Google show its account chooser every time", () => {
    expect(oauthQueryParams("google")).toEqual({ prompt: "select_account" });
  });

  it("adds nothing for Apple", () => {
    expect(oauthQueryParams("apple")).toBeUndefined();
  });
});
