"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";

export default function SentryExamplePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-fg text-2xl font-bold">Sentry Example Page</h1>
      <p className="text-fg-muted">
        Click the button below to throw a test error and verify Sentry is working.
      </p>
      <Button
        variant="danger"
        onClick={() => {
          const error = new Error("Sentry Example Frontend Error");
          Sentry.captureException(error);
          throw error;
        }}
      >
        Throw Client Error
      </Button>
      <Button
        variant="secondary"
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
      </Button>
    </div>
  );
}
