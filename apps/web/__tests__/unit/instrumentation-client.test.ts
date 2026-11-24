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

  it("exports Sentry's router transition hook", () => {
    expect(onRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
  });
});
