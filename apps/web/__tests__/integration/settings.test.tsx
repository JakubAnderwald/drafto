import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BYTES_PER_MEGABYTE } from "@drafto/shared";
import SettingsPage from "@/app/settings/page";

// The Delete account section needs the router and the browser Supabase client.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({ error: null }) },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

// Mock fetch. The Storage section loads its usage on its own, so GET /api/storage-usage is
// answered by `mockStorageFetch`; every other request (the API key calls) goes to `mockFetch`.
const STORAGE_USAGE_URL = "/api/storage-usage";
const mockFetch = vi.fn();
const mockStorageFetch = vi.fn();
global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  input === STORAGE_USAGE_URL
    ? mockStorageFetch(input, init)
    : mockFetch(input, init)) as typeof fetch;

const MB = BYTES_PER_MEGABYTE;

function storageUsageResponse(usedBytes: number, quotaBytes: number | null) {
  return { ok: true, json: () => Promise.resolve({ usedBytes, quotaBytes }) };
}

function storageSection(): HTMLElement {
  return screen.getByTestId("storage-usage-section");
}

// Renders the page with no API keys and the given storage usage response, and waits for both to load.
async function renderWithStorage(storageResponse: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
  mockStorageFetch.mockResolvedValueOnce(storageResponse);
  const result = render(<SettingsPage />);
  await waitFor(() => {
    expect(screen.getByText("No API keys yet. Generate one to get started.")).toBeInTheDocument();
    expect(within(storageSection()).queryByText("Storage: loading…")).not.toBeInTheDocument();
  });
  return result;
}

// Mock navigator.clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageFetch.mockResolvedValue(storageUsageResponse(0, 50 * MB));
  });

  it("renders the settings page with API keys heading", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(<SettingsPage />);

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("API Keys")).toBeInTheDocument();
  });

  it("shows loading state and then empty message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("No API keys yet. Generate one to get started.")).toBeInTheDocument();
    });
  });

  it("displays existing API keys", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "key-1",
            key_prefix: "dk_abcde",
            name: "Claude Desktop",
            created_at: "2026-04-11T00:00:00Z",
            last_used_at: "2026-04-11T12:00:00Z",
            revoked_at: null,
          },
        ]),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
      expect(screen.getByText(/dk_abcde/)).toBeInTheDocument();
    });
  });

  it("creates a new API key and shows it", async () => {
    const user = userEvent.setup();

    // First: fetch existing keys (empty)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("No API keys yet. Generate one to get started.")).toBeInTheDocument();
    });

    // Type key name
    const input = screen.getByPlaceholderText("Key name (e.g. Claude Desktop)");
    await user.type(input, "Test Key");

    // Mock create response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "key-new",
          key_prefix: "dk_test12",
          name: "Test Key",
          key: "dk_abcdef123456789012345678901234567890123456789012",
        }),
    });

    // Mock refresh response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "key-new",
            key_prefix: "dk_test12",
            name: "Test Key",
            created_at: "2026-04-11T00:00:00Z",
            last_used_at: null,
            revoked_at: null,
          },
        ]),
    });

    // Click generate
    await user.click(screen.getByText("Generate key"));

    // Wait for the key to appear
    await waitFor(() => {
      expect(screen.getByText(/dk_abcdef/)).toBeInTheDocument();
    });
  });

  it("revokes an API key", async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            id: "key-1",
            key_prefix: "dk_abcde",
            name: "My Key",
            created_at: "2026-04-11T00:00:00Z",
            last_used_at: null,
            revoked_at: null,
          },
        ]),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("My Key")).toBeInTheDocument();
    });

    // Mock revoke response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "key-1", revoked: true }),
    });

    // Mock refresh response (empty - key is revoked)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await user.click(screen.getByText("Revoke"));

    await waitFor(() => {
      expect(screen.getByText("No API keys yet. Generate one to get started.")).toBeInTheDocument();
    });
  });

  it("shows the MCP connection config", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(<SettingsPage />);

    expect(screen.getByText("Connect to Claude")).toBeInTheDocument();
    expect(screen.getByText(/YOUR_API_KEY/)).toBeInTheDocument();
  });

  it("renders the Delete account section as the last section", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    const { container } = render(<SettingsPage />);

    const section = screen.getByTestId("delete-account-section");
    expect(section).toHaveTextContent("Delete account");
    expect(section.className).toContain("mt-6");
    expect(container.firstElementChild?.lastElementChild).toBe(section);

    await waitFor(() => {
      expect(screen.getByText("No API keys yet. Generate one to get started.")).toBeInTheDocument();
    });
    // Rendering the section must not add any request of its own.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shows error when key creation fails", async () => {
    const user = userEvent.setup();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("No API keys yet. Generate one to get started.")).toBeInTheDocument();
    });

    // Mock failed create
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: "Rate limited" }),
    });

    await user.click(screen.getByText("Generate key"));

    await waitFor(() => {
      expect(screen.getByText("Rate limited")).toBeInTheDocument();
    });
  });
  describe("Storage section", () => {
    it("sits between the Connect to Claude card and the Delete account section", async () => {
      await renderWithStorage(storageUsageResponse(0, 50 * MB));

      const section = storageSection();
      expect(section).toHaveTextContent("Storage");
      expect(section.className).toContain("mt-6");
      expect(section.nextElementSibling).toBe(screen.getByTestId("delete-account-section"));
      expect(section.previousElementSibling).toHaveTextContent("Connect to Claude");
      expect(mockStorageFetch).toHaveBeenCalledTimes(1);
      expect(mockStorageFetch).toHaveBeenCalledWith(STORAGE_USAGE_URL, undefined);
    });

    it("shows a quiet loading line until the usage arrives", async () => {
      let respond: (value: unknown) => void = () => {};
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
      mockStorageFetch.mockReturnValueOnce(
        new Promise((resolve) => {
          respond = resolve;
        }),
      );

      render(<SettingsPage />);

      expect(within(storageSection()).getByText("Storage: loading…")).toBeInTheDocument();
      expect(within(storageSection()).queryByRole("progressbar")).not.toBeInTheDocument();

      respond(storageUsageResponse(5 * MB, 50 * MB));
      await waitFor(() => {
        expect(
          within(storageSection()).getByText("Storage: 5 MB of 50 MB used"),
        ).toBeInTheDocument();
      });
    });

    it("shows used and quota megabytes with a default-tone bar", async () => {
      await renderWithStorage(storageUsageResponse(Math.round(12.4 * MB), 50 * MB));

      const section = storageSection();
      expect(within(section).getByText("Storage: 12.4 MB of 50 MB used")).toBeInTheDocument();
      const bar = within(section).getByRole("progressbar", { name: "Storage used" });
      expect(bar).toHaveAttribute("aria-valuenow", "25");
      expect(within(bar).getByTestId("progress-bar-fill")).toHaveClass("bg-primary-500");
    });

    it("shows only the used amount and no bar when storage is unlimited", async () => {
      await renderWithStorage(storageUsageResponse(3 * MB, null));

      const section = storageSection();
      expect(within(section).getByText("Storage: 3 MB used")).toBeInTheDocument();
      expect(within(section).queryByText(/ of /)).not.toBeInTheDocument();
      expect(within(section).queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("keeps the default tone at exactly 90% of the quota", async () => {
      await renderWithStorage(storageUsageResponse(45 * MB, 50 * MB));

      const fill = within(storageSection()).getByTestId("progress-bar-fill");
      expect(fill).toHaveClass("bg-primary-500");
      expect(fill).not.toHaveClass("bg-warning");
    });

    it("turns the bar to the warning tone above 90% of the quota", async () => {
      await renderWithStorage(storageUsageResponse(46 * MB, 50 * MB));

      const section = storageSection();
      expect(within(section).getByText("Storage: 46 MB of 50 MB used")).toBeInTheDocument();
      const bar = within(section).getByRole("progressbar", { name: "Storage used" });
      expect(bar).toHaveAttribute("aria-valuenow", "92");
      expect(within(bar).getByTestId("progress-bar-fill")).toHaveClass("bg-warning");
    });

    it("turns the bar to the danger tone at 100% of the quota", async () => {
      await renderWithStorage(storageUsageResponse(50 * MB, 50 * MB));

      const section = storageSection();
      expect(within(section).getByText("Storage: 50 MB of 50 MB used")).toBeInTheDocument();
      const bar = within(section).getByRole("progressbar", { name: "Storage used" });
      expect(bar).toHaveAttribute("aria-valuenow", "100");
      expect(within(bar).getByTestId("progress-bar-fill")).toHaveClass("bg-error");
    });

    it("keeps the bar full and in the danger tone when usage is over the quota", async () => {
      await renderWithStorage(storageUsageResponse(60 * MB, 50 * MB));

      const bar = within(storageSection()).getByRole("progressbar", { name: "Storage used" });
      expect(bar).toHaveAttribute("aria-valuenow", "100");
      expect(within(bar).getByTestId("progress-bar-fill")).toHaveClass("bg-error");
    });

    it.each([
      {
        case: "the request fails",
        response: { ok: false, json: () => Promise.resolve({ error: "Unauthorized" }) },
      },
      {
        case: "the body is not a usage",
        response: { ok: true, json: () => Promise.resolve({ usedBytes: "lots" }) },
      },
      {
        case: "the quota is not a number",
        response: { ok: true, json: () => Promise.resolve({ usedBytes: 1, quotaBytes: "50" }) },
      },
      {
        case: "the body is not JSON",
        response: { ok: true, json: () => Promise.reject(new SyntaxError("Unexpected token")) },
      },
    ])("says usage is unavailable when $case", async ({ response }) => {
      await renderWithStorage(response);

      const section = storageSection();
      expect(within(section).getByText("Storage usage unavailable")).toBeInTheDocument();
      expect(within(section).queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("says usage is unavailable when the network request throws", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });
      mockStorageFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(within(storageSection()).getByText("Storage usage unavailable")).toBeInTheDocument();
      });
    });
  });
});
