import { claimAppleRevocationDelivery } from "@/lib/apple-revocation";
import { claimAuthCallbackDelivery } from "@/lib/auth-callback";

/**
 * Expo Router passes every incoming URL through here before routing it.
 *
 * `drafto://auth/callback` is not a screen. It ends Apple sign-in on Android,
 * and the app signs in from it here. Returning `null` tells the router not to
 * navigate. A running app stays where sign-in started; a cold start opens the
 * default route, and the route guard moves on once the session lands. Before
 * this, the router showed "Unmatched Route" on top of a successful sign-in.
 *
 * `drafto://auth/apple-revocation` is not a screen either. It ends the Apple
 * confirmation of an Android account deletion. The browser session that asked
 * for it reads it, and the router's copy is handed to the pending confirmation
 * too, in case that session resolved as "dismiss" before the link arrived. A
 * late copy, after the deletion was lost, is dropped; the user starts again.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  if (claimAppleRevocationDelivery(path)) return null;
  return claimAuthCallbackDelivery(path) ? null : path;
}
