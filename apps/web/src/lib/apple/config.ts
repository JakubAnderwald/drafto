import { env } from "@/env";

/** The Sign in with Apple key the server signs its `client_secret` JWTs with. */
export interface AppleSignInKey {
  teamId: string;
  keyId: string;
  /** PEM contents of the `.p8` key, with real newlines. */
  privateKey: string;
}

/**
 * Reads the Sign in with Apple key from the environment, or `null` unless all
 * three variables are set. The private key may be stored multi-line, or on one
 * line with literal `\n` escapes, as some secret stores require.
 */
export function getAppleSignInKey(): AppleSignInKey | null {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_SIGN_IN_KEY_ID?.trim();
  const privateKey = env.APPLE_SIGN_IN_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey };
}
