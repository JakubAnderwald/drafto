import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSendMock };
  },
}));

describe("email client", () => {
  beforeEach(() => {
    vi.resetModules();
    resendSendMock.mockReset();
  });

  it("returns null and logs when RESEND_API_KEY is missing", async () => {
    vi.doMock("@/env", () => ({
      env: { EMAIL_FROM: "Drafto <hello@drafto.eu>" },
    }));
    const { sendEmail } = await import("@/lib/email/client");
    const Sentry = await import("@sentry/nextjs");

    const result = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>x</p>",
      text: "x",
    });
    expect(result).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalled();
  });

  it("sends successfully and returns the Resend id", async () => {
    vi.doMock("@/env", () => ({
      env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Drafto <hello@drafto.eu>" },
    }));
    resendSendMock.mockResolvedValue({ data: { id: "email-123" }, error: null });

    const { sendEmail } = await import("@/lib/email/client");
    const result = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>x</p>",
      text: "x",
    });
    expect(result).toEqual({ id: "email-123" });
    expect(resendSendMock).toHaveBeenCalledWith({
      from: "Drafto <hello@drafto.eu>",
      to: "user@example.com",
      subject: "hi",
      html: "<p>x</p>",
      text: "x",
    });
  });

  it("passes replyTo through when given", async () => {
    vi.doMock("@/env", () => ({
      env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Drafto <hello@drafto.eu>" },
    }));
    resendSendMock.mockResolvedValue({ data: { id: "email-456" }, error: null });

    const { sendEmail } = await import("@/lib/email/client");
    await sendEmail({
      to: "admin@example.com",
      subject: "hi",
      html: "<p>x</p>",
      text: "x",
      replyTo: "support@drafto.eu",
    });
    expect(resendSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", replyTo: "support@drafto.eu" }),
    );
  });

  it("captures error and returns null when Resend returns an error", async () => {
    vi.doMock("@/env", () => ({
      env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Drafto <hello@drafto.eu>" },
    }));
    resendSendMock.mockResolvedValue({ data: null, error: { message: "rate limited" } });

    const { sendEmail } = await import("@/lib/email/client");
    const Sentry = await import("@sentry/nextjs");

    const result = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>x</p>",
      text: "x",
    });
    expect(result).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it("swallows thrown errors and returns null", async () => {
    vi.doMock("@/env", () => ({
      env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Drafto <hello@drafto.eu>" },
    }));
    resendSendMock.mockRejectedValue(new Error("network"));

    const { sendEmail } = await import("@/lib/email/client");
    const result = await sendEmail({
      to: "user@example.com",
      subject: "hi",
      html: "<p>x</p>",
      text: "x",
    });
    expect(result).toBeNull();
  });
});
