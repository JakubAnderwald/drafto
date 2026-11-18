declare module "@env" {
  export const SUPABASE_URL: string;
  export const SUPABASE_ANON_KEY: string;
  export const API_URL: string | undefined;
  /** "1" in E2E builds only: turns on the test-only accessible probes (src/lib/e2e-probes.ts). */
  export const E2E_PROBES: string | undefined;
}
