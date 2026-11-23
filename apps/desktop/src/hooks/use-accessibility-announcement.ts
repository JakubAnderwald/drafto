import { useEffect } from "react";
import { AccessibilityInfo } from "react-native";

export interface AccessibilityAnnouncementOptions {
  /**
   * Waits behind speech already in progress instead of interrupting it, so two announcements
   * made in the same render (two inline form errors) are both heard. On macOS this posts the
   * announcement at low priority.
   */
  queue?: boolean;
  /**
   * The form's submit counter. Bump it on every submit (or other try, such as an OAuth button)
   * and the message is spoken again even when the new try fails with the same words.
   */
  attempt?: number;
}

/**
 * Has VoiceOver speak `message` each time it changes to a new non-null value, or
 * `options.attempt` changes while it is shown. null stays silent, and a re-render
 * with the same message and attempt doesn't repeat it.
 *
 * On macOS this posts NSAccessibilityAnnouncementRequestedNotification
 * (react-native-macos RCTAccessibilityManager), the only way to make VoiceOver
 * speak a status change that doesn't take focus: an `accessibilityRole` of
 * "alert" maps to no macOS role and announces nothing.
 *
 * An announcement is fire-and-forget: one made while VoiceOver isn't attached
 * yet (a launch that starts offline) isn't repeated. The element that shows
 * the message stays readable, so VoiceOver still finds it there.
 */
export function useAccessibilityAnnouncement(
  message: string | null,
  options: AccessibilityAnnouncementOptions = {},
): void {
  const { queue = false, attempt } = options;
  useEffect(() => {
    if (!message) return;
    if (queue) {
      AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
    } else {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message, queue, attempt]);
}
