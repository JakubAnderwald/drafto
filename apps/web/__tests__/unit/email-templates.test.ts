import { describe, expect, it } from "vitest";
import { accountActiveEmail, newSignupAdminEmail } from "@/lib/email/templates";

describe("email templates", () => {
  describe("newSignupAdminEmail", () => {
    const baseInput = {
      userEmail: "newuser@example.com",
      userDisplayName: "Jane Doe",
      signupAt: new Date("2026-04-20T12:00:00Z"),
      adminUrl: "https://drafto.eu/admin",
    };

    it("includes the user email and the admin URL, and says the account is already active", () => {
      const out = newSignupAdminEmail(baseInput);
      expect(out.subject).toContain("newuser@example.com");
      expect(out.html).toContain("newuser@example.com");
      expect(out.html).toContain(baseInput.adminUrl);
      expect(out.text).toContain(baseInput.adminUrl);
      expect(out.html).toContain("Their account is already active.");
      expect(out.text).toContain("Their account is already active.");
    });

    it("has no approve link: signup is open (ADR 0094)", () => {
      const out = newSignupAdminEmail(baseInput);
      expect(out.html).not.toMatch(/approve/i);
      expect(out.text).not.toMatch(/approve/i);
      expect(out.html).toContain("suspend");
    });

    it("escapes HTML in user email and display name", () => {
      const out = newSignupAdminEmail({
        ...baseInput,
        userEmail: "<script>@example.com",
        userDisplayName: "<img src=x>",
      });
      expect(out.html).not.toContain("<script>");
      expect(out.html).not.toContain("<img src=x>");
      expect(out.html).toContain("&lt;script&gt;");
      expect(out.html).toContain("&lt;img src=x&gt;");
    });

    it("omits display_name section when null", () => {
      const out = newSignupAdminEmail({ ...baseInput, userDisplayName: null });
      expect(out.html).not.toContain("Name");
    });

    it("uses Drafto design system colors (indigo primary, warm neutrals)", () => {
      const out = newSignupAdminEmail(baseInput);
      // Uses Drafto primary indigo
      expect(out.html).toContain("#3525cd");
      // Uses warm neutral backgrounds
      expect(out.html).toContain("#fff8f5");
      expect(out.html).toContain("#fcf2eb");
      // Does not use the previous generic palette
      expect(out.html).not.toContain("#2563eb");
      expect(out.html).not.toContain("#f4f4f5");
      expect(out.html).not.toContain("#fafafa");
      expect(out.html).not.toContain("#18181b");
    });

    it("includes a non-empty plaintext alternative", () => {
      const out = newSignupAdminEmail(baseInput);
      expect(out.text.length).toBeGreaterThan(0);
      expect(out.text).toContain("New Drafto signup");
    });

    it("renders the shared Drafto footer", () => {
      const out = newSignupAdminEmail(baseInput);
      expect(out.html).toContain("drafto.eu");
      expect(out.html).toContain("Drafto");
    });
  });

  describe("accountActiveEmail", () => {
    it("greets user by display name when provided", () => {
      const out = accountActiveEmail({
        displayName: "Jane",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).toContain("Hi Jane");
      expect(out.text).toContain("Hi Jane,");
      expect(out.html).toContain("https://drafto.eu/login");
    });

    it("falls back to 'there' when display name missing", () => {
      const out = accountActiveEmail({
        displayName: null,
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).toContain("Hi there");
      expect(out.text).toContain("Hi there,");
    });

    it("escapes HTML in display name", () => {
      const out = accountActiveEmail({
        displayName: "<b>x</b>",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).not.toContain("<b>x</b>");
      expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    });

    it("uses Drafto design system colors (indigo primary, warm neutrals)", () => {
      const out = accountActiveEmail({
        displayName: "Jane",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).toContain("#3525cd");
      expect(out.html).toContain("#fff8f5");
      expect(out.html).not.toContain("#2563eb");
      expect(out.html).not.toContain("#f4f4f5");
      expect(out.html).not.toContain("#fafafa");
      expect(out.html).not.toContain("#18181b");
    });

    it("includes a non-empty plaintext alternative", () => {
      const out = accountActiveEmail({
        displayName: "Jane",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.text.length).toBeGreaterThan(0);
      expect(out.text).toContain("Jane");
      expect(out.text).toContain("https://drafto.eu/login");
    });

    it("renders the shared Drafto footer", () => {
      const out = accountActiveEmail({
        displayName: "Jane",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).toContain("drafto.eu");
    });
  });
});
