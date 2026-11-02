import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { act, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { SettingsContent } from "@/components/settings/settings-content";
import { SITE_URL } from "@/lib/site";

// The "Connect to Claude" card's MCP config snippet (#748). On the server the snippet has no
// access to the request, so it renders drafto.eu's origin. The browser must hydrate that HTML as is, then show the
// origin the page is served from: a preview's own URL, or localhost here in jsdom.

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

const mockFetch = vi.fn<typeof fetch>();

interface McpConfig {
  mcpServers: { drafto: { url: string } };
}

// The url the snippet currently shows.
function snippetUrl(): string {
  const snippet = screen.getByText(/"mcpServers"/);
  return (JSON.parse(snippet.textContent ?? "") as McpConfig).mcpServers.drafto.url;
}

// Renders `element` to HTML the way the Next.js server does, where there is no `window`.
function renderOnServer(element: ReactElement): string {
  vi.stubGlobal("window", undefined);
  try {
    return renderToString(element);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("Settings MCP snippet", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    mockFetch.mockImplementation(async () => Response.json([]));
    global.fetch = mockFetch;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    mockFetch.mockReset();
  });

  it("runs on an origin other than drafto.eu, so a mismatch would show", () => {
    expect(window.location.origin).not.toBe(SITE_URL);
  });

  it("server-renders the drafto.eu origin", () => {
    container.innerHTML = renderOnServer(<SettingsContent />);

    expect(snippetUrl()).toBe(`${SITE_URL}/api/mcp`);
  });

  it("hydrates the server HTML without an error, then shows the page's own origin", async () => {
    const onRecoverableError = vi.fn();
    container.innerHTML = renderOnServer(<SettingsContent />);

    await act(async () => {
      root = hydrateRoot(container, <SettingsContent />, { onRecoverableError });
    });
    // Let the API key list finish loading so its state update lands inside act().
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(snippetUrl()).toBe(`${window.location.origin}/api/mcp`);
  });

  it("shows the page's own origin straight away when first rendered in the browser", async () => {
    render(<SettingsContent />);

    expect(snippetUrl()).toBe(`${window.location.origin}/api/mcp`);
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
  });
});
