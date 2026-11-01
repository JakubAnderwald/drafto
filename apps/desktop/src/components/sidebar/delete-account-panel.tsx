import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  appleDeletionNotice,
  describeAccountDeletionFailure,
  type AccountDeletionResult,
  type AppleRevocationGrant,
} from "@drafto/shared";

import { Button } from "@/components/ui/button";
import { useAppleDeletionConfirmation } from "@/hooks/use-apple-deletion-confirmation";
import { startAppleConfirmation, type AppleConfirmation } from "@/lib/apple-revocation";
import { useTheme } from "@/providers/theme-provider";
import { fontFamily, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export const DELETE_ACCOUNT_WARNING =
  "This permanently deletes your Drafto account and all of your notebooks, notes and attachments. This cannot be undone.";
export const DELETE_ACCOUNT_PROMPT = "Type DELETE to confirm";
export const DELETE_ACCOUNT_OFFLINE_NOTE = "Deleting your account needs an internet connection.";
export const DELETE_ACCOUNT_APPLE_NOTICE = appleDeletionNotice("browser");
export const DELETE_ACCOUNT_APPLE_WAITING = "Confirm with Apple in your browser…";

interface DeleteAccountPanelProps {
  onCancel: () => void;
  /**
   * Sends the deletion. Resolving `ok` means the auth provider has already signed out.
   * After the Apple step it gets Apple's grant (absent when skipped or refused) and the
   * id of the user who started it, so a session that switched meanwhile is not deleted.
   */
  onConfirm: (
    appleRevocation?: AppleRevocationGrant,
    confirmedUserId?: string,
  ) => Promise<AccountDeletionResult>;
  /** Deletion needs the server, so the confirm button stays disabled while offline. */
  isOffline?: boolean;
  /** Keeps the confirm button disabled without the offline note, e.g. during a sign-out. */
  disabled?: boolean;
}

/**
 * Inline type-`DELETE`-to-confirm step for account deletion. Inline rather than a
 * `Modal`: `Modal` is unproven on the react-native-macos fossil build, and the
 * sidebar already hosts inline `TextInput`s.
 *
 * An Apple-linked user first confirms with Apple in the browser. The browser tells the
 * app nothing when its tab is closed, so the waiting state offers **Continue without
 * Apple** (deletes now) and **Cancel** (deletes nothing). There is no timeout: it would
 * delete the account with no one watching.
 */
export function DeleteAccountPanel({
  onCancel,
  onConfirm,
  isOffline = false,
  disabled = false,
}: DeleteAccountPanelProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const apple = useAppleDeletionConfirmation();

  const [confirmation, setConfirmation] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWaitingForApple, setIsWaitingForApple] = useState(false);
  // The Apple step in progress. Cleared by Cancel and on unmount, so a grant that lands
  // afterwards deletes nothing.
  const appleConfirmationRef = useRef<AppleConfirmation | null>(null);
  // A ref, not state, so a double click inside one frame cannot send two requests.
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pendingApple = appleConfirmationRef.current;
      appleConfirmationRef.current = null;
      pendingApple?.skip();
    };
  }, []);

  const isBusy = isPending || isWaitingForApple;
  const canConfirm =
    confirmation.trim() === ACCOUNT_DELETE_CONFIRMATION && !isBusy && !isOffline && !disabled;

  const handleConfirm = async () => {
    if (!canConfirm || inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);

    if (!apple.required) {
      await sendDeletion();
      return;
    }

    const confirmedUserId = apple.userId ?? undefined;
    const appleConfirmation = startAppleConfirmation();
    appleConfirmationRef.current = appleConfirmation;
    setIsWaitingForApple(true);
    const grant = await appleConfirmation.grant;
    // Cancelled or unmounted while Apple was open: nothing is deleted.
    if (!mountedRef.current || appleConfirmationRef.current !== appleConfirmation) return;
    appleConfirmationRef.current = null;
    setIsWaitingForApple(false);
    await sendDeletion(grant ?? undefined, confirmedUserId);
  };

  const continueWithoutApple = () => {
    appleConfirmationRef.current?.skip();
  };

  const cancelAppleStep = () => {
    const pendingApple = appleConfirmationRef.current;
    appleConfirmationRef.current = null;
    pendingApple?.skip();
    inFlightRef.current = false;
    setIsWaitingForApple(false);
  };

  const sendDeletion = async (...args: Parameters<DeleteAccountPanelProps["onConfirm"]>) => {
    setIsPending(true);
    let result: AccountDeletionResult;
    try {
      result = await onConfirm(...args);
    } catch (err) {
      console.error("Account deletion failed:", err);
      result = { status: "failed", httpStatus: 0 };
    }

    // On success the session is gone and the navigator swaps to the login screen,
    // unmounting this panel — stay pending until then rather than re-enabling it.
    if (!mountedRef.current || result.status === "ok") return;
    inFlightRef.current = false;
    setIsPending(false);
    setError(describeAccountDeletionFailure(result));
  };

  return (
    <View style={styles.container}>
      <Text style={styles.warning}>{DELETE_ACCOUNT_WARNING}</Text>
      {apple.required ? (
        <Text testID="delete-account-apple-notice" style={styles.note}>
          {DELETE_ACCOUNT_APPLE_NOTICE}
        </Text>
      ) : null}

      <Text style={styles.label}>{DELETE_ACCOUNT_PROMPT}</Text>
      <TextInput
        testID="delete-account-input"
        style={styles.input}
        value={confirmation}
        onChangeText={setConfirmation}
        placeholder={ACCOUNT_DELETE_CONFIRMATION}
        placeholderTextColor={semantic.fgSubtle}
        accessibilityLabel={DELETE_ACCOUNT_PROMPT}
        autoCorrect={false}
        editable={!isBusy}
        autoFocus
        // @ts-expect-error -- RN macOS supports onKeyDown but types are incomplete
        onKeyDown={(e: { nativeEvent: { key: string } }) => {
          if (e.nativeEvent.key === "Escape" && !isBusy) {
            onCancel();
          }
        }}
      />

      {isOffline ? <Text style={styles.note}>{DELETE_ACCOUNT_OFFLINE_NOTE}</Text> : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {isWaitingForApple ? (
        <View style={styles.actions}>
          <Text testID="delete-account-apple-waiting" style={styles.label}>
            {DELETE_ACCOUNT_APPLE_WAITING}
          </Text>
          <Button
            testID="delete-account-apple-skip"
            title="Continue without Apple"
            variant="danger"
            size="sm"
            fullWidth
            onPress={continueWithoutApple}
          />
          <Button
            testID="delete-account-apple-cancel"
            title="Cancel"
            variant="secondary"
            size="sm"
            fullWidth
            onPress={cancelAppleStep}
          />
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            testID="delete-account-confirm"
            title="Delete account"
            variant="danger"
            size="sm"
            fullWidth
            onPress={handleConfirm}
            disabled={!canConfirm}
            loading={isPending}
          />
          <Button
            testID="delete-account-cancel"
            title="Cancel"
            variant="secondary"
            size="sm"
            fullWidth
            onPress={onCancel}
            disabled={isPending}
          />
        </View>
      )}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      marginTop: spacing.sm,
      padding: spacing.sm,
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: semantic.errorBorder,
      borderRadius: radii.md,
      backgroundColor: semantic.errorBg,
    },
    warning: {
      fontSize: fontSizes.sm,
      color: semantic.fg,
      fontFamily: fontFamily.sans,
    },
    label: {
      fontSize: fontSizes.sm,
      fontWeight: "600",
      color: semantic.fgMuted,
      fontFamily: fontFamily.sans,
    },
    input: {
      fontSize: fontSizes.base,
      color: semantic.fg,
      backgroundColor: semantic.bg,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: radii.sm,
      padding: spacing.xs,
      paddingHorizontal: spacing.sm,
      fontFamily: fontFamily.sans,
    },
    note: {
      fontSize: fontSizes.sm,
      color: semantic.fgMuted,
      fontFamily: fontFamily.sans,
    },
    error: {
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      fontFamily: fontFamily.sans,
    },
    actions: {
      gap: spacing.xs,
    },
  });
