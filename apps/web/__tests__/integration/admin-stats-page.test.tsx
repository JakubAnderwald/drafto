import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { fakeMetricsClient } from "../fixtures/product-metrics";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "admin-id" } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { is_admin: true }, error: null }) }),
      }),
    }),
  })),
}));

const adminClient = { current: fakeMetricsClient() };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient.current }));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));

const { default: AdminStatsPage } = await import("@/app/(app)/admin/stats/page");

const SECTION_ORDER = [
  "Needs attention",
  "Platform limits",
  "Activation",
  "Writers",
  "Depth",
  "Sign-ups",
  "Active users and retention",
];

async function renderPage() {
  render(await AdminStatsPage());
}

describe("/admin/stats against faked metric functions", () => {
  it("renders the header and the seven sections in order", async () => {
    adminClient.current = fakeMetricsClient();
    await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Product metrics" })).toBeInTheDocument();
    expect(screen.getByText(/Admins and test accounts are excluded/)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      SECTION_ORDER,
    );
  });

  it("shows counts beside every rate", async () => {
    adminClient.current = fakeMetricsClient();
    await renderPage();

    const activation = within(screen.getByTestId("metrics-section-activation"));
    expect(activation.getByText("2 of 3 (66.7%)")).toBeInTheDocument();
    expect(activation.getByText("1 of 3 (33.3%)")).toBeInTheDocument();
    expect(activation.getByText("—*")).toBeInTheDocument();

    const depth = within(screen.getByTestId("metrics-section-depth"));
    expect(depth.getByText("3 of 8 (37.5%)")).toBeInTheDocument();
    expect(depth.getByText("2 of 8 (25%)")).toBeInTheDocument();

    const active = within(screen.getByTestId("metrics-section-active-users"));
    expect(active.getByText("4 of 6 (66.7%)")).toBeInTheDocument();
    expect(active.getByText("3 of 4 (75%)")).toBeInTheDocument();

    // Every percentage on the page sits next to its counts or its bytes.
    const text = document.body.textContent ?? "";
    for (const match of text.matchAll(/\((\d+(?:\.\d)?)%\)/g)) {
      const before = text.slice(Math.max(0, match.index - 30), match.index);
      expect(before).toMatch(/(\d+ of \d+|MB|GB) $/);
    }
  });

  it("flags the warning limit and the emptied note under Needs attention", async () => {
    adminClient.current = fakeMetricsClient();
    await renderPage();

    const attention = within(screen.getByTestId("metrics-section-needs-attention"));
    expect(attention.queryByText("Nothing needs attention")).not.toBeInTheDocument();
    expect(attention.getByText("11111111-1111-4111-8111-111111111111")).toBeInTheDocument();
    expect(attention.getByText("1,234")).toBeInTheDocument();
    expect(attention.getByText(/Storage: 768 MB of 1 GB/)).toBeInTheDocument();
  });

  it("shows no email-shaped text", async () => {
    adminClient.current = fakeMetricsClient();
    await renderPage();

    expect(document.body.textContent).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  });

  it("keeps one failing metric to its own section", async () => {
    adminClient.current = fakeMetricsClient({
      metrics_signups: {
        data: null,
        error: { code: "42501", message: "permission denied for table users" },
      },
      metrics_retention: {
        data: null,
        error: { code: "PGRST202", message: "Could not find the function" },
      },
    });
    await renderPage();

    expect(
      within(screen.getByTestId("metrics-section-signups")).getByRole("alert"),
    ).toHaveTextContent("metrics_signups failed (42501)");
    expect(
      within(screen.getByTestId("metrics-section-active-users")).getByText(
        "Available after usage tracking ships",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("metrics-section-writers")).getByRole("table"),
    ).toBeInTheDocument();
  });
});
