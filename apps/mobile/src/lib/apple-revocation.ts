import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import type { User } from "@supabase/supabase-js";
import { APPLE_NATIVE_CLIENT_ID, type AppleRevocationGrant } from "@drafto/shared";

type AppleLinkable = Pick<User, "identities" | "app_metadata"> | null | undefined;

/** True when the account has a Sign in with Apple identity linked. */
export function hasAppleIdentity(user: AppleLinkable): boolean {
  if (!user) return false;
  if (user.identities?.some((identity) => identity.provider === "apple")) return true;
  const providers: unknown = user.app_metadata?.providers;
  return Array.isArray(providers) && providers.includes("apple");
}

/**
 * Whether deleting this account first asks the user to confirm with Apple.
 *
 * Only on iOS, where the native sheet can return a fresh authorization code
 * without a browser. Android signs in to Apple through Supabase's browser flow,
 * which never hands the app an Apple code, so it deletes without this step.
 */
export function needsAppleConfirmation(user: AppleLinkable): boolean {
  return Platform.OS === "ios" && hasAppleIdentity(user);
}

/**
 * Asks Apple, through the native sheet, for a fresh authorization code that the
 * server redeems and revokes once the account is deleted (App Store Review
 * Guideline 5.1.1(v)). Supabase keeps no Apple token, so this is the only way to
 * get one.
 *
 * Returns `null`, so the deletion goes ahead without revocation, when the user
 * is not linked to Apple, is not on iOS, cancels the sheet, or Apple fails.
 * Revocation is best-effort and must never stop a deletion.
 */
export async function requestAppleRevocationGrant(
  user: AppleLinkable,
): Promise<AppleRevocationGrant | null> {
  if (!needsAppleConfirmation(user)) return null;

  try {
    // No name or email: only the authorization code is needed.
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    if (!credential.authorizationCode) {
      console.warn("[apple-revocation] Apple returned no authorization code");
      return null;
    }
    // The sheet issues codes to the app's bundle ID, which the server knows by the same constant.
    return { authorizationCode: credential.authorizationCode, clientId: APPLE_NATIVE_CLIENT_ID };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "ERR_REQUEST_CANCELED") {
      console.warn("[apple-revocation] Apple confirmation failed", { code });
    }
    return null;
  }
}
