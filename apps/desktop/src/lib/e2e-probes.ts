import { E2E_PROBES } from "@env";

// Test-only probes the E2E checks read, such as the editor's image render
// status views (ADR-0086). They are accessible views, so VoiceOver would read
// them to real users: a build has them only when it was bundled with
// E2E_PROBES=1 (in the environment or apps/desktop/.env; react-native-dotenv
// inlines it at build time). TestFlight and App Store builds never set it, so
// they are off by default.

/** Whether the build-time flag's value turns the probes on: only exactly "1". */
export function isE2EProbesFlag(value: string | undefined): boolean {
  return value === "1";
}

/** Whether this build carries the E2E probes. */
export function areE2EProbesEnabled(): boolean {
  return isE2EProbesFlag(E2E_PROBES);
}
