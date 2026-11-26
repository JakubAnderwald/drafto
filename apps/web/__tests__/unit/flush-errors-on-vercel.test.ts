import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportError, resetReportErrorThrottle } from "@/lib/report-error";
import {
  flushErrorsBeforeVercelFreezes,
  SENTRY_FLUSH_TIMEOUT_MS,
} from "@/lib/sentry/flush-errors-on-vercel";

// Runs the real Sentry SDK, not a mock: reportError → captureException → the hook → flush →
// transport. Only the upload is faked, as a slow request, so the test can see whether the function
// would have been kept open until the event left. (Vitest resolves @sentry/nextjs to its browser
// build; the capture, hook and flush code is @sentry/core's, shared with the Node and edge SDKs.)

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const UPLOAD_MS = 50;

type WaitUntil = (task: Promise<unknown>) => void;
type Global = Record<symbol, unknown>;

let uploaded: string[];

function decode(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

function initSentry() {
  return Sentry.init({
    dsn: "https://public@o0.ingest.sentry.io/0",
    defaultIntegrations: false,
    transport: (options: Parameters<typeof Sentry.createTransport>[0]) =>
      Sentry.createTransport(options, async (request) => {
        await new Promise((resolve) => setTimeout(resolve, UPLOAD_MS));
        uploaded.push(decode(request.body));
        return { statusCode: 200 };
      }),
  });
}

function setRequestContext(waitUntil: WaitUntil | undefined) {
  (globalThis as Global)[VERCEL_REQUEST_CONTEXT] =
    waitUntil === undefined ? undefined : { get: () => ({ waitUntil }) };
}

describe("flushErrorsBeforeVercelFreezes", () => {
  beforeEach(() => {
    uploaded = [];
    resetReportErrorThrottle();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    delete (globalThis as Global)[VERCEL_REQUEST_CONTEXT];
    await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
    vi.restoreAllMocks();
  });

  it("hands Vercel a task that ends only once the reported error is uploaded", async () => {
    const tasks: Promise<unknown>[] = [];
    setRequestContext((task) => tasks.push(task));
    flushErrorsBeforeVercelFreezes(initSentry());

    reportError(new Error("exchange failed"), "auth:callback", { level: "warning" });

    // The capture call itself registers the task, while the request is still running.
    expect(tasks).toHaveLength(1);
    expect(uploaded).toHaveLength(0);

    await expect(tasks[0]).resolves.toBe(true);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toContain('"where":"auth:callback"');
    expect(uploaded[0]).toContain("exchange failed");
  });

  it("does nothing outside a Vercel request", async () => {
    const client = initSentry();
    flushErrorsBeforeVercelFreezes(client);

    expect(() => reportError(new Error("local"), "local:site")).not.toThrow();

    await client?.flush(SENTRY_FLUSH_TIMEOUT_MS);
    expect(uploaded).toHaveLength(1);
  });

  it("leaves transactions alone", () => {
    const waitUntil = vi.fn<WaitUntil>();
    setRequestContext(waitUntil);
    const client = initSentry();
    flushErrorsBeforeVercelFreezes(client);

    client?.emit("preprocessEvent", { type: "transaction" }, {});

    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("accepts a client that was never created", () => {
    expect(() => flushErrorsBeforeVercelFreezes(undefined)).not.toThrow();
  });
});
