"use client";

import * as Sentry from "@sentry/nextjs";

export default function SentryExamplePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">Sentry Example Page</h1>
      <p className="text-muted-foreground">
        Click the button below to throw a test error and verify Sentry is working.
      </p>
      <button
        type="button"
        className="rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700"
        onClick={() => {
          const error = new Error("Sentry Example Frontend Error");
          Sentry.captureException(error);
          throw error;
        }}
      >
        Throw Client Error
      </button>
      <button
        type="button"
        className="rounded bg-orange-600 px-4 py-2 text-white hover:bg-orange-700"
        onClick={async () => {
          await Sentry.startSpan({ name: "Example Frontend Span", op: "test" }, async () => {
            const response = await fetch("/api/sentry-example-api");
            if (!response.ok) {
              const error = new Error("Sentry Example API Response Error");
              Sentry.captureException(error);
              throw error;
            }
          });
        }}
      >
        Throw API Error
      </button>
    </div>
  );
}
