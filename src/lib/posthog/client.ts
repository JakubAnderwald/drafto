import posthog from "posthog-js";
import { env } from "@/env";

export function getPostHogClient() {
  if (typeof window === "undefined") return null;

  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = env.NEXT_PUBLIC_POSTHOG_HOST;

  if (!key) return null;

  if (!posthog.__loaded) {
    posthog.init(key, {
      api_host: host || "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: false, // We capture manually in the provider
    });
  }

  return posthog;
}
