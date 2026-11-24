import * as Sentry from "@sentry/nextjs";
import { sentryEnabled } from "@/lib/sentry-environment";

// One way for apps/web to report an error it catches and carries on from (ADR-0099). Safe in
// browser, Node and edge (middleware) code: it imports only the Sentry SDK and the shared Sentry
// environment flag.

export type ReportErrorLevel = "error" | "warning";

export interface ReportErrorOptions {
  // Non-sensitive context: IDs, counts, status codes. Never note content, search text or file names.
  extra?: Record<string, unknown>;
  level?: ReportErrorLevel;
  // Report at most once per `where` in this window on this instance (an outage must not send one
  // event per request). The error is still logged on the server inside the window.
  throttleMs?: number;
}

const lastReportedAt = new Map<string, number>();

// Supabase and fetch hand back plain objects ({ message, code }) and strings. Sentry groups those
// poorly ("Object captured as exception"), so wrap them in an Error that carries the message.
export function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (typeof err === "string") {
    return new Error(err);
  }
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return new Error(err.message);
  }
  try {
    // JSON.stringify gives undefined (not a throw) for undefined, functions and symbols.
    return new Error(JSON.stringify(err) ?? String(err));
  } catch {
    return new Error(String(err));
  }
}

// The browser's Sentry client has captureConsoleIntegration({ levels: ["error"] }), so a
// console.error there would report the same error a second time. Log only where nothing captures
// the console: on the server (Vercel's function logs keep the line) or with Sentry off.
function shouldLog(): boolean {
  return typeof window === "undefined" || !sentryEnabled;
}

function isThrottled(where: string, throttleMs: number | undefined): boolean {
  if (!throttleMs) {
    return false;
  }
  const now = Date.now();
  const last = lastReportedAt.get(where);
  if (last !== undefined && now - last < throttleMs) {
    return true;
  }
  lastReportedAt.set(where, now);
  return false;
}

export function reportError(err: unknown, where: string, options: ReportErrorOptions = {}): void {
  const { extra, level = "error", throttleMs } = options;

  if (shouldLog()) {
    console.error(`[${where}]`, err);
  }

  if (isThrottled(where, throttleMs)) {
    return;
  }

  Sentry.captureException(toError(err), {
    level,
    tags: { where },
    extra: { where, ...extra },
  });
}

// Test-only: forget the throttle windows between tests.
export function resetReportErrorThrottle(): void {
  lastReportedAt.clear();
}
