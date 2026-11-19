import {
  SIGN_OUT_ANYWAY_LABEL,
  SIGN_OUT_CONFIRM_LABEL,
  SIGN_OUT_SYNCED_MESSAGE,
  SIGN_OUT_UNKNOWN_MESSAGE,
} from "../constants";

/** The message and confirm-button label of the confirmation shown before a sign-out. */
export interface SignOutCopy {
  message: string;
  confirmLabel: string;
}

/**
 * The unsynced-changes warning. The macOS In-Test harness (apps/desktop/e2e/in-test/lib/app.sh,
 * sign_out_confirm_copy) matches this wording, so change both together.
 */
export function describeUnsyncedLoss(count: number): string {
  return count === 1
    ? "1 change hasn't synced and will be lost."
    : `${count} changes haven't synced and will be lost.`;
}

/**
 * What the sign-out confirmation on mobile and desktop says (useSafeSignOut): how many changes
 * would be lost, a reassurance when nothing is pending, or a generic warning when the count
 * could not be read (`null`).
 */
export function describeSignOut(pending: number | null): SignOutCopy {
  if (pending === null) {
    return { message: SIGN_OUT_UNKNOWN_MESSAGE, confirmLabel: SIGN_OUT_CONFIRM_LABEL };
  }
  if (pending > 0) {
    return { message: describeUnsyncedLoss(pending), confirmLabel: SIGN_OUT_ANYWAY_LABEL };
  }
  return { message: SIGN_OUT_SYNCED_MESSAGE, confirmLabel: SIGN_OUT_CONFIRM_LABEL };
}
