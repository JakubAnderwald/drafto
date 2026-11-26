import type * as Sentry from "@sentry/nextjs";

// A Vercel function is frozen as soon as its response is sent, unless something was handed to the
// request's `waitUntil`. The Sentry SDK only sends an event after the request handler has carried
// on (stack frames, context lines and the HTTP upload are all async), and on Node @sentry/nextjs
// never calls `waitUntil` itself: core's `vercelWaitUntil` returns early outside the Edge runtime,
// and a Turbopack build doesn't wrap route handlers with the wrappers that would flush. So a caught
// error reported from a route, a server component or the cron was dropped with the frozen function
// (ADR-0099).
//
// This keeps the invocation open until Sentry has sent what it holds. It reads Vercel's request
// context the way `waitUntil` from `@vercel/functions` does, so there is no new dependency. Outside
// a Vercel request (the browser, `next dev`, `next start`, tests) there is no context and it does
// nothing.

type SentryClient = NonNullable<ReturnType<typeof Sentry.init>>;

interface VercelRequestContext {
  waitUntil?: (task: Promise<unknown>) => void;
}

interface VercelRequestContextStore {
  get?: () => VercelRequestContext | undefined;
}

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

// Long enough for one upload to de.sentry.io, short enough not to bill a stuck upload for long.
export const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

function requestWaitUntil(): VercelRequestContext["waitUntil"] {
  const store = (globalThis as Record<symbol, VercelRequestContextStore | undefined>)[
    VERCEL_REQUEST_CONTEXT
  ];
  return store?.get?.()?.waitUntil;
}

// Error events only: a transaction is sent after the response and needs no help here.
// `preprocessEvent` runs inside the capture call, so the request's context is still current.
export function flushErrorsBeforeVercelFreezes(client: SentryClient | undefined): void {
  client?.on("preprocessEvent", (event) => {
    if (event.type !== undefined) return;
    const waitUntil = requestWaitUntil();
    // `flush` returns a PromiseLike; hand Vercel a real Promise.
    waitUntil?.(Promise.resolve(client.flush(SENTRY_FLUSH_TIMEOUT_MS)));
  });
}
