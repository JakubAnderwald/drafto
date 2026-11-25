# 0099 — The Web App Reports Caught Errors Through reportError

- **Status**: Accepted
- **Date**: 2026-11-24
- **Authors**: Jakub Anderwald (with Claude Code)
- **Issue**: [#472](https://github.com/JakubAnderwald/drafto/issues/472)

## Context

`CLAUDE.md` says errors flow through Sentry automatically, and "do not swallow errors silently". That held only for errors that escaped: uncaught exceptions, unhandled rejections and errors thrown out of a route handler. About 23 places in `apps/web` caught an error, wrote it with `console.error` and carried on. They included creating, moving and deleting notes in the app shell, loading the notebook list, search, attachment signed URLs, the auth callback, the waiting-for-approval page, the trash-cleanup cron and the session middleware.

None of those reached Sentry. On the server, `console.error` lands in Vercel's function logs, which nobody reads unless something else points there. In the browser it lands in the user's DevTools console: the browser Sentry client (`instrumentation-client.ts`) had no console capture. Most of the browser sites also gave the user no feedback. A note that failed to create, or a notebook that failed to move, did nothing visible.

## Decision

1. **One helper.** `reportError(err, where, { extra, level, throttleMs })` in `apps/web/src/lib/report-error.ts` is the one way `apps/web` reports an error it catches and carries on from. It imports only `@sentry/nextjs` and `@/lib/sentry-environment`, so the same function works in browser, Node and edge (middleware) code.
   - It wraps a non-`Error` value (Supabase's `{ message, code }` objects, strings) in an `Error` that carries the message, so Sentry groups it by that message instead of "Object captured as exception".
   - It tags every event with `where`, a short kebab/colon string naming the site (`app-shell:create-note`, `api:notes-search`, `cron:cleanup-trash`), and repeats it in `extra`.
   - `level` defaults to `"error"`. Pass `"warning"` for a failure the app recovers from by itself.
   - `throttleMs` reports at most once per `where` in that window on one instance. It is for per-request server paths such as the middleware, where an outage would otherwise send one event per request.
2. **Browser backstop.** `instrumentation-client.ts` adds `Sentry.captureConsoleIntegration({ levels: ["error"] })`. A browser `console.error` that no `reportError` call replaced, including one from a library, still reaches Sentry.
3. **No duplicates.** `reportError` writes `console.error` itself only on the server (Vercel's function logs keep the line) or when Sentry is off (local development). It never logs in the browser while Sentry is on, because the console integration would capture the same error a second time. So at every site the `console.error` is _replaced_ by `reportError`, never kept beside it.
4. **User feedback.** A failure of something the user did (note create, move and delete; notebook load) shows the `Alert` primitive (`apps/web/src/components/ui/alert.tsx`): an inline `role="alert"` message in the error tone, with an optional action such as Retry and a Dismiss button.
5. **Privacy.** `extra` carries IDs, counts and status codes only. Never note content, search query text, attachment file names or file paths. The SDKs attach request data of their own: the server and edge SDKs add the URL of the request an event came from, and the browser SDK records each fetch's URL as a breadcrumb. The search route takes the search text as `?q=`, so `beforeSend` in all three Sentry configs runs `scrubSearchQuery` (`apps/web/src/lib/sentry/scrub-search-query.ts`), which drops the query string from a search URL in an error event's request and breadcrumbs. It doesn't scrub performance traces or Session Replay's network entries, which recorded search URLs before this ADR too.

## Consequences

- **Positive**: Every caught failure in `apps/web` reaches Sentry with the site that caught it, so a failing action shows up as an issue instead of a silent no-op. Users see that an action failed and can retry it. One helper keeps the event shape, wrapping and throttling the same at every site.
- **Negative**: The console backstop turns every remaining browser `console.error`, including third-party libraries', into a Sentry event. Each one also triggers an on-error Session Replay (`replaysOnErrorSampleRate: 1.0`). On Sentry's Free plan that can use up the error and replay quotas faster. If it does, add the noisy message to `ignoreErrors` rather than dropping the integration.
- **Negative**: An error caught by a React error boundary that also calls `reportError` can be reported twice, because React logs caught render errors to the console itself. Sentry's default dedupe integration drops most of these. The rest are rare and harmless.
- **Neutral**: A new rule for contributors: a caught-and-continued error in `apps/web` goes through `reportError`, never a bare `console.error` (`CLAUDE.md` → Error Handling). Tests mock `@/lib/report-error` and assert the `where` tag instead of spying on `console.error`.

## Alternatives Considered

- **Console capture only** (add `captureConsoleIntegration` and leave the `console.error` calls). Rejected: events would carry no `where` tag or structured context, plain objects would be captured badly, and server-side sites would still not reach Sentry. Keeping the `console.error` beside a direct capture would also double every browser event.
- **`Sentry.captureException` at each site.** Rejected: each site would repeat the wrapping, tags and logging rules, and drift. There would be no shared throttle for the per-request server paths, and no single place to keep the no-duplicate rule.
- **Server-side console capture** (the integration in the server and edge configs too). Rejected: Vercel's function logs already keep server lines, the explicit `reportError` calls cover the server sites with better context, and capturing every server `console.error` would spend quota on noise.
