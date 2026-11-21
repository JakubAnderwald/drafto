import { Alert } from "react-native";

export const CONTENT_FULL_ALERT_TITLE = "Notes Full";

/**
 * Tells the user that notes were left unsynced for the content quota (ADR 0090).
 * Desktop has no toast, so it is an alert. The database provider calls it once when
 * notes first stop fitting, not on each sync that retries them.
 */
export function showContentFullAlert(message: string): void {
  Alert.alert(CONTENT_FULL_ALERT_TITLE, message);
}
