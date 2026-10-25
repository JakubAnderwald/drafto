import "server-only";
import { env } from "@/env";

// The git commit SHA the running deployment was built from (Vercel's `VERCEL_GIT_COMMIT_SHA`),
// so whoever tests a preview can confirm it's the commit under test. Read per request by
// `/api/health` and the Settings page. `null` when it's unset or empty, e.g. locally.
export function getBuildCommit(): string | null {
  return env.VERCEL_GIT_COMMIT_SHA || null;
}
