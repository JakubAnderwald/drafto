import { needsAppleConfirmation } from "@/lib/apple-revocation";
import { useAuth } from "@/providers/auth-provider";

export interface AppleDeletionConfirmationState {
  /** True when the signed-in account has Sign in with Apple linked. */
  required: boolean;
  /** The signed-in user's id, captured when the Apple step starts. */
  userId: string | null;
}

/** Whether deleting the signed-in account first asks Apple to confirm in the browser. */
export function useAppleDeletionConfirmation(): AppleDeletionConfirmationState {
  const { user } = useAuth();
  return { required: needsAppleConfirmation(user), userId: user?.id ?? null };
}
