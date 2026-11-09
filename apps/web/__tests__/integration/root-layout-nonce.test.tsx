/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The root layout's inline theme script under the CSP (ADR-0069): it must carry the nonce the
// middleware forwards, or the browser blocks it and dark mode flashes in after hydration.

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}));

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

// The provider reads the router's pathname, which has no context outside Next.js.
vi.mock("@/lib/posthog/provider", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { default: RootLayout } = await import("@/app/layout");

// The script exactly as it shipped before the CSP: only the nonce is new.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}})()`;

async function renderLayout(): Promise<string> {
  return renderToStaticMarkup(await RootLayout({ children: <main>page</main> }));
}

function themeScripts(html: string): Array<{ attributes: string; body: string }> {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attributes, body]) => ({
    attributes,
    body,
  }));
}

describe("RootLayout theme script", () => {
  beforeEach(() => {
    requestHeaders.current = new Headers();
  });

  it("carries the middleware's nonce", async () => {
    requestHeaders.current = new Headers({ "x-nonce": "bm9uY2UtZnJvbS1taWRkbGV3YXJl" });

    const scripts = themeScripts(await renderLayout());

    expect(scripts).toHaveLength(1);
    expect(scripts[0].attributes).toContain('nonce="bm9uY2UtZnJvbS1taWRkbGV3YXJl"');
  });

  it("keeps the script body unchanged", async () => {
    requestHeaders.current = new Headers({ "x-nonce": "abc" });

    const [script] = themeScripts(await renderLayout());

    expect(script.body).toBe(THEME_SCRIPT);
  });

  it("renders no nonce attribute when the middleware didn't run", async () => {
    // e.g. a path the matcher skips. Such a response carries no CSP, so the script still runs.
    const [script] = themeScripts(await renderLayout());

    expect(script.attributes).not.toContain("nonce");
    expect(script.body).toBe(THEME_SCRIPT);
  });

  it("still renders the page inside the body", async () => {
    const html = await renderLayout();

    expect(html).toContain("<main>page</main>");
    expect(html).toMatch(/<body class="font-geist-sans font-geist-mono antialiased">/);
  });
});
