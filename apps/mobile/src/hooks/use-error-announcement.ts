import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/**
 * Has VoiceOver speak an error, an inline field error or a form's banner, each time it appears
 * (PrimeTestLab 11035 M-02). An empty or missing error stays silent.
 *
 * `attempt` is the form's submit counter: bump it on every submit (or other try, such as an
 * OAuth button) and the error is spoken again even when the new try fails with the same words.
 * Without it, or while it stays the same, a re-render with the same error doesn't repeat it.
 *
 * iOS needs this because `accessibilityRole="alert"` maps to no UIAccessibility trait and
 * `accessibilityLiveRegion` is Android-only, so an error that appears while focus stays on the
 * submit button is otherwise never spoken. The announcement is queued behind speech already in
 * progress, so two errors shown by the same submit are both heard. Android skips it: the error's
 * polite live region already announces it, and posting both would read it twice.
 */
export function useErrorAnnouncement(message: string | null | undefined, attempt?: number): void {
  useEffect(() => {
    if (!message || Platform.OS === "android") return;
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  }, [message, attempt]);
}
