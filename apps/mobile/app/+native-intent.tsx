import { claimAuthCallbackDelivery } from "@/lib/auth-callback";

/**
 * Expo Router passes every incoming URL through here before routing it.
 *
 * `drafto://auth/callback` is not a screen. It ends Apple sign-in on Android,
 * and the app signs in from it here. Returning `null` tells the router not to
 * navigate. A running app stays where sign-in started; a cold start opens the
 * default route, and the route guard moves on once the session lands. Before
 * this, the router showed "Unmatched Route" on top of a successful sign-in.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  return claimAuthCallbackDelivery(path) ? null : path;
}
