import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { AppShell } = await import("@/components/layout/app-shell");

describe("AppShell", () => {
  it("renders three panels", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await act(async () => {
      render(
        <AppShell>
          <div>children content</div>
        </AppShell>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Notebooks")).toBeInTheDocument();
      expect(screen.getByText("Select a note")).toBeInTheDocument();
    });
  });

  it("shows 'Select a notebook' when none selected", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await act(async () => {
      render(
        <AppShell>
          <div>children content</div>
        </AppShell>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Select a notebook")).toBeInTheDocument();
    });
  });
});
