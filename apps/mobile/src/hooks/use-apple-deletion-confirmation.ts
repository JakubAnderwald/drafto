import { appleConfirmationKind, type MobileAppleConfirmationKind } from "@/lib/apple-revocation";
import { useAuth } from "@/providers/auth-provider";

/**
 * How deleting the signed-in account will ask the user to confirm with Apple first
 * (`"sheet"` on iOS, `"browser"` on Android), or `null` when it will not, so the delete
 * dialog can say so before they start.
 */
export function useAppleDeletionConfirmation(): MobileAppleConfirmationKind | null {
  const { user } = useAuth();
  return appleConfirmationKind(user);
}
