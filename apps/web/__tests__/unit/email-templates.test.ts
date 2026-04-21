import { describe, expect, it } from "vitest";
import { newSignupAdminEmail, userApprovedEmail } from "@/lib/email/templates";

describe("email templates", () => {
  describe("newSignupAdminEmail", () => {
    const baseInput = {
      userEmail: "newuser@example.com",
      userDisplayName: "Jane Doe",
      signupAt: new Date("2026-04-20T12:00:00Z"),
      approveUrl: "https://drafto.eu/api/admin/approve-user/one-click?token=t",
      adminUrl: "https://drafto.eu/admin",
    };

    it("includes user email, approve URL, and admin URL", () => {
      const out = newSignupAdminEmail(baseInput);
      expect(out.subject).toContain("newuser@example.com");
      expect(out.html).toContain("newuser@example.com");
      expect(out.html).toContain(baseInput.approveUrl);
      expect(out.html).toContain(baseInput.adminUrl);
      expect(out.text).toContain(baseInput.approveUrl);
      expect(out.text).toContain(baseInput.adminUrl);
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
  });

  describe("userApprovedEmail", () => {
    it("greets user by display name when provided", () => {
      const out = userApprovedEmail({
        displayName: "Jane",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).toContain("Hi Jane");
      expect(out.text).toContain("Hi Jane,");
      expect(out.html).toContain("https://drafto.eu/login");
    });

    it("falls back to 'there' when display name missing", () => {
      const out = userApprovedEmail({
        displayName: null,
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).toContain("Hi there");
      expect(out.text).toContain("Hi there,");
    });

    it("escapes HTML in display name", () => {
      const out = userApprovedEmail({
        displayName: "<b>x</b>",
        loginUrl: "https://drafto.eu/login",
      });
      expect(out.html).not.toContain("<b>x</b>");
      expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    });
  });
});
