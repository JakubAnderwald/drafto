import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeMetricsClient } from "../fixtures/product-metrics";

/**
 * The Monday metrics route end to end: the real loader, report, renderer and email client,
 * with only Supabase (RPC, profiles, auth admin) and Resend faked.
 */

const SECRET = "i".repeat(40);
vi.mock("@/env", () => ({
  env: {
    CRON_SECRET: SECRET,
    APP_URL: "https://drafto.eu",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Drafto <hello@drafto.eu>",
  },
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const resendSend = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

const ADMINS: Record<string, string> = {
  "admin-1": "first-admin@example.com",
  "admin-2": "second-admin@example.com",
};
const admins = { ids: Object.keys(ADMINS) };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...fakeMetricsClient(),
    from: (table: string) => ({
      select: () => ({
        eq: async (column: string, value: unknown) => {
          if (table !== "profiles" || column !== "is_admin" || value !== true) {
            return { data: null, error: new Error(`unexpected query ${table}.${column}`) };
          }
          return { data: admins.ids.map((id) => ({ id })), error: null };
        },
      }),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { id, email: ADMINS[id] } },
          error: null,
        }),
      },
    },
  }),
}));

const { GET } = await import("@/app/api/cron/weekly-metrics/route");

function cronRequest() {
  return new NextRequest("http://localhost:3000/api/cron/weekly-metrics", {
    headers: { Authorization: `Bearer ${SECRET}`, "User-Agent": "vercel-cron/1.0" },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Monday 2026-11-23 06:00 UTC: reports on 2026-W47, the fixture's newest week.
  vi.setSystemTime(new Date("2026-11-23T06:00:00Z"));
  resendSend.mockReset();
  resendSend.mockResolvedValue({ data: { id: "email-1" }, error: null });
  admins.ids = Object.keys(ADMINS);
});

describe("GET /api/cron/weekly-metrics against faked Supabase and Resend", () => {
  it("sends every admin one email with the week's metrics", async () => {
    const res = await GET(cronRequest());
    vi.useRealTimers();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sent: 2,
      recipients: 2,
      generatedAt: "2026-11-23T06:00:00.000Z",
    });

    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(resendSend.mock.calls.map(([m]) => m.to)).toEqual([
      "first-admin@example.com",
      "second-admin@example.com",
    ]);
    const [message] = resendSend.mock.calls[0];
    expect(message).toMatchObject({
      from: "Drafto <hello@drafto.eu>",
      replyTo: "support@drafto.eu",
      // The fixture's storage limit is at 75% and a note was emptied on 2026-11-18.
      subject: "Drafto weekly metrics — 2026-W47 — needs attention",
    });

    const { text, html } = message as { text: string; html: string };
    expect(text).toContain(
      "- 2026-11-18 10:00 UTC, web, 1,234 characters before, note 11111111-1111-4111-8111-111111111111",
    );
    expect(text).toContain("- Supabase — Egress: 4.25 GB of 5 GB (85%), critical");
    expect(text).toContain("- Storage: 768 MB of 1 GB (75%), warn");
    expect(text).toContain("- Weekly active users: 6 (week before: —)");
    expect(text).toContain("- Weekly writers: 4 (week before: —)");
    expect(text).toContain("- Sign-ups: 3 (week before: 1)");
    expect(text).toContain("- Activation, cohort 2026-W37: — (week before: —)");
    expect(text).toContain("- Database: 100 MB of 500 MB (20%), ok");
    expect(text).toContain("All metrics: https://drafto.eu/admin/stats");
    expect(html).toContain("background:#fff4e0");

    // No user id, and no address but the recipient's (which isn't in the body either).
    for (const body of [text, html]) {
      expect(body).not.toContain("22222222-2222-4222-8222-222222222222");
      expect(body).not.toMatch(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i);
    }
  });

  it("sends nothing when there are no admins", async () => {
    admins.ids = [];
    const res = await GET(cronRequest());
    vi.useRealTimers();
    expect(await res.json()).toMatchObject({ sent: 0, recipients: 0 });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("returns 502 when Resend fails", async () => {
    resendSend.mockResolvedValue({ data: null, error: { message: "rate limited" } });
    const res = await GET(cronRequest());
    vi.useRealTimers();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ sent: 0, recipients: 2 });
  });
});
