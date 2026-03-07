import { PostHog } from "posthog-node";
import { env } from "@/env";

export function getPostHogServerClient() {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = env.NEXT_PUBLIC_POSTHOG_HOST;

  if (!key) return null;

  return new PostHog(key, {
    host: host || "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
}
