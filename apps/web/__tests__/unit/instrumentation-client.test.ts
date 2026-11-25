import { describe, expect, it, vi } from "vitest";

const { sentry, replayMarker, consoleMarker } = vi.hoisted(() => {
  const replayMarker = { name: "Replay" };
  const consoleMarker = { name: "CaptureConsole" };
  return {
    replayMarker,
    consoleMarker,
    sentry: {
      init: vi.fn(),
      replayIntegration: vi.fn(() => replayMarker),
      captureConsoleIntegration: vi.fn(() => consoleMarker),
      captureRouterTransitionStart: vi.fn(),
    },
  };
});

vi.mock("@sentry/nextjs", () => sentry);

import { onRouterTransitionStart } from "../../instrumentation-client";

describe("instrumentation-client", () => {
  it("captures console.error calls as a backstop (ADR-0099)", () => {
    expect(sentry.captureConsoleIntegration).toHaveBeenCalledWith({ levels: ["error"] });
  });

  it("registers the console capture and replay integrations with Sentry.init", () => {
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0][0] as { integrations: unknown[] };
    expect(options.integrations).toContain(consoleMarker);
    expect(options.integrations).toContain(replayMarker);
  });

  it("drops the search text from an event's fetch breadcrumbs before sending (ADR-0099)", () => {
    const options = sentry.init.mock.calls[0][0] as {
      beforeSend: (event: Record<string, unknown>) => Record<string, unknown>;
    };
    const event = {
      breadcrumbs: [{ category: "fetch", data: { url: "/api/notes/search?q=secret" } }],
    };
    expect(JSON.stringify(options.beforeSend(event))).not.toContain("secret");
  });

  it("drops the search text from each breadcrumb as it is recorded, for Replay's network entries too (ADR-0099)", () => {
    const options = sentry.init.mock.calls[0][0] as {
      beforeBreadcrumb: (breadcrumb: Record<string, unknown>) => Record<string, unknown>;
    };
    const breadcrumb = { category: "fetch", data: { url: "/api/notes/search?q=secret" } };
    expect(JSON.stringify(options.beforeBreadcrumb(breadcrumb))).not.toContain("secret");
  });

  it("exports Sentry's router transition hook", () => {
    expect(onRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
  });
});
