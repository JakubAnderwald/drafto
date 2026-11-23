import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/**
 * Has VoiceOver speak an inline field error each time it changes to a new non-empty value
 * (PrimeTestLab 11035 M-02). An empty or missing error stays silent, and a re-render with the
 * same error doesn't repeat it.
 *
 * iOS needs this because `accessibilityRole="alert"` maps to no UIAccessibility trait and
 * `accessibilityLiveRegion` is Android-only, so an error that appears while focus stays on the
 * submit button is otherwise never spoken. The announcement is queued behind speech already in
 * progress, so two errors shown by the same submit are both heard. Android skips it: the error's
 * polite live region already announces it, and posting both would read it twice.
 */
export function useFieldErrorAnnouncement(errorText: string | undefined): void {
  useEffect(() => {
    if (!errorText || Platform.OS === "android") return;
    AccessibilityInfo.announceForAccessibilityWithOptions(errorText, { queue: true });
  }, [errorText]);
}
