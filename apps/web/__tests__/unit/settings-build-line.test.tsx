import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";

// The page reads the commit through `@/env`; each case sets it on this object.
const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  VERCEL_GIT_COMMIT_SHA: undefined as string | undefined,
}));
vi.mock("@/env", () => ({ env: mockEnv }));

// The Delete account section needs the router and the browser Supabase client.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({ error: null }) },
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// The Storage and Notes sections load GET /api/storage-usage and /api/content-usage on their
// own; answer them here so the queued responses below only feed the API key requests.
const mockFetch = vi.fn();
global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  input === "/api/storage-usage" || input === "/api/content-usage"
    ? Promise.resolve({ ok: true, json: () => Promise.resolve({ usedBytes: 0, quotaBytes: null }) })
    : mockFetch(input, init)) as typeof fetch;

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function renderSettings() {
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
  const result = render(<SettingsPage />);
  // Let the API key list finish loading so its state update lands inside act().
  await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
  return result;
}

describe("Settings page build line", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.VERCEL_GIT_COMMIT_SHA = undefined;
  });

  it("shows the first 7 characters of the commit in small muted monospace text", async () => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = SHA;

    await renderSettings();

    const line = screen.getByTestId("build-commit");
    expect(line.textContent).toBe("Build 0123456");
    expect(line).toHaveClass("text-fg-muted", "font-mono", "text-xs");
  });

  it("PrimeTestLab 11035 S-01: renders the line last in the About section, the page's last card", async () => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = SHA;

    const { container } = await renderSettings();

    const line = screen.getByTestId("build-commit");
    const about = screen.getByTestId("about-section");
    expect(about).toContainElement(line);
    expect(line.parentElement?.lastElementChild).toBe(line);
    expect(line.previousElementSibling).toContainElement(screen.getByTestId("about-support"));
    expect(container.firstElementChild?.lastElementChild).toBe(about);
    expect(about.previousElementSibling).toBe(screen.getByTestId("delete-account-section"));
  });

  it("renders no build line when the commit is unset", async () => {
    await renderSettings();

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByTestId("build-commit")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Build /)).not.toBeInTheDocument();
    // The About section's links still show without a build line.
    expect(screen.getByTestId("about-privacy")).toBeInTheDocument();
  });

  it("renders no build line when the commit is empty", async () => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = "";

    await renderSettings();

    expect(screen.queryByTestId("build-commit")).not.toBeInTheDocument();
  });
});
