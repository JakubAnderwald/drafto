import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "@/app/settings/page";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

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
});
