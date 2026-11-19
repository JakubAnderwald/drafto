import Constants from "expo-constants";

// Test-only probes the E2E checks read, such as the editor's image render
// status views (ADR-0086). They are accessible views, so VoiceOver and TalkBack
// would read them to real users: a build has them only when it was made with
// EXPO_PUBLIC_E2E_PROBES=1 (app.config.ts puts the flag in `extra` at build
// time). Store and TestFlight builds never set it, so they are off by default.

/** Whether the build-time flag's value turns the probes on: only exactly `true`. */
export function isE2EProbesFlag(value: unknown): boolean {
  return value === true;
}

/** Whether this build carries the E2E probes. */
export function areE2EProbesEnabled(): boolean {
  return isE2EProbesFlag(Constants.expoConfig?.extra?.e2eProbes);
}
