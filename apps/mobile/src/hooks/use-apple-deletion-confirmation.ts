import { needsAppleConfirmation } from "@/lib/apple-revocation";
import { useAuth } from "@/providers/auth-provider";

/**
 * True when deleting the signed-in account will ask the user to confirm with
 * Apple first, so the delete dialog can say so before they start.
 */
export function useAppleDeletionConfirmation(): boolean {
  const { user } = useAuth();
  return needsAppleConfirmation(user);
}
