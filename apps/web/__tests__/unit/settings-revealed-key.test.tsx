import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { SettingsContent } from "@/components/settings/settings-content";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

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

const mockFetch = vi.fn();
global.fetch = mockFetch;

const NEW_KEY = "dk_0123456789abcdef0123456789abcdef0123456789abcdef";
const NEW_KEY_NAME = "Fresh key";
const OLD_KEY_NAME = "Old key";
const EMPTY_MESSAGE = "No API keys yet. Generate one to get started.";

const NEW_ROW = {
  id: "key-new",
  key_prefix: NEW_KEY.slice(0, 8),
  name: NEW_KEY_NAME,
  created_at: "2026-10-24T12:00:00Z",
  last_used_at: null,
  revoked_at: null,
};

const OLD_ROW = {
  id: "key-1",
  key_prefix: "dk_fedcb",
  name: OLD_KEY_NAME,
  created_at: "2026-10-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
};

function jsonResponse(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function keyRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest("li");
  if (!row) throw new Error(`No API key row named "${name}"`);
  return row;
}

async function renderSettings(existingKeys: unknown[]) {
  mockFetch.mockResolvedValueOnce(jsonResponse(existingKeys));
  render(<SettingsContent />);
  await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
}

// Generates NEW_KEY; `refreshedKeys` is the list the follow-up GET returns.
async function generateNewKey(user: UserEvent, refreshedKeys: unknown[]) {
  await user.type(screen.getByPlaceholderText("Key name (e.g. Claude Desktop)"), NEW_KEY_NAME);
  mockFetch
    .mockResolvedValueOnce(
      jsonResponse({
        id: NEW_ROW.id,
        key_prefix: NEW_ROW.key_prefix,
        name: NEW_KEY_NAME,
        key: NEW_KEY,
      }),
    )
    .mockResolvedValueOnce(jsonResponse(refreshedKeys));
  await user.click(screen.getByRole("button", { name: "Generate key" }));
  // The button is re-enabled last, once the list has been refetched.
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate key" })).toBeEnabled());
}

// Revokes the row named `name`; `refreshedKeys` is the list the follow-up GET returns.
async function revokeKey(user: UserEvent, name: string, id: string, refreshedKeys: unknown[]) {
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ id, revoked: true }))
    .mockResolvedValueOnce(jsonResponse(refreshedKeys));
  await user.click(within(keyRow(name)).getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(screen.queryByText(name)).not.toBeInTheDocument());
  expect(mockFetch).toHaveBeenCalledWith(`/api/api-keys/${id}`, { method: "DELETE" });
}

describe("Settings revealed API key", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the box once the key it shows is revoked", async () => {
    const user = userEvent.setup();
    await renderSettings([]);
    await generateNewKey(user, [NEW_ROW]);
    expect(screen.getByText(NEW_KEY)).toBeInTheDocument();

    await revokeKey(user, NEW_KEY_NAME, NEW_ROW.id, []);

    expect(screen.getByText(EMPTY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(NEW_KEY)).not.toBeInTheDocument();
    expect(screen.queryByText(/copy it now/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy to clipboard" })).not.toBeInTheDocument();
  });

  it("keeps showing the new key when a different key is revoked", async () => {
    const user = userEvent.setup();
    await renderSettings([OLD_ROW]);
    await generateNewKey(user, [NEW_ROW, OLD_ROW]);

    await revokeKey(user, OLD_KEY_NAME, OLD_ROW.id, [NEW_ROW]);

    expect(screen.getByText(NEW_KEY)).toBeInTheDocument();
    expect(screen.getByText(/copy it now/)).toBeInTheDocument();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(writeText).toHaveBeenCalledWith(NEW_KEY);
  });

  it("keeps showing the key when revoking it fails", async () => {
    const user = userEvent.setup();
    await renderSettings([]);
    await generateNewKey(user, [NEW_ROW]);

    // Hold the DELETE open, then fail it inside act() so any state update it causes has landed.
    let failDelete: (value: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        failDelete = resolve;
      }),
    );
    await user.click(within(keyRow(NEW_KEY_NAME)).getByRole("button", { name: "Revoke" }));
    expect(mockFetch).toHaveBeenLastCalledWith(`/api/api-keys/${NEW_ROW.id}`, {
      method: "DELETE",
    });
    await act(async () => {
      failDelete({ ok: false, json: () => Promise.resolve({ error: "Internal error" }) });
    });

    // The key is still active, so its row and the box both stay.
    expect(keyRow(NEW_KEY_NAME)).toBeInTheDocument();
    expect(screen.getByText(NEW_KEY)).toBeInTheDocument();
    expect(screen.getByText(/copy it now/)).toBeInTheDocument();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(writeText).toHaveBeenCalledWith(NEW_KEY);
  });

  it("shows a generated key's value once, with a working copy button", async () => {
    const user = userEvent.setup();
    await renderSettings([]);
    await generateNewKey(user, [NEW_ROW]);

    // The list row shows only the prefix, so the full value appears once: in the box.
    expect(screen.getAllByText(NEW_KEY)).toHaveLength(1);
    expect(screen.getByText(/copy it now — it will not be shown again/)).toBeInTheDocument();
    expect(within(keyRow(NEW_KEY_NAME)).queryByText(NEW_KEY)).not.toBeInTheDocument();

    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    expect(writeText).toHaveBeenCalledWith(NEW_KEY);
  });
});
