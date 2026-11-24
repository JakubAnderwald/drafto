/**
 * Extra query parameters for a browser OAuth sign-in (Supabase `signInWithOAuth`'s
 * `options.queryParams`), by provider.
 *
 * Google gets `prompt=select_account`, so its account chooser opens every time instead of
 * silently reusing the account the browser last signed in with. Without it, a user who signed out
 * of Drafto to switch Google accounts lands straight back in the old one (PrimeTestLab 11035 M-03).
 * Other providers get nothing: Apple has no such prompt.
 */
export function oauthQueryParams(provider: string): Record<string, string> | undefined {
  return provider === "google" ? { prompt: "select_account" } : undefined;
}
