import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, View } from "react-native";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  describeAccountDeletionFailure,
  type AccountDeletionResult,
} from "@drafto/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export interface DeleteAccountDialogProps {
  visible: boolean;
  onCancel: () => void;
  /** Performs the deletion. On `ok` the auth state change routes the user to login. */
  onConfirm: () => Promise<AccountDeletionResult>;
}

const CONFIRM_PROMPT = `Type ${ACCOUNT_DELETE_CONFIRMATION} to confirm`;

/**
 * Type-to-confirm dialog for permanent account deletion. The destructive button
 * stays disabled until the exact confirmation word is entered, and while a
 * request is in flight. Failures are shown inline and keep the dialog open.
 */
export function DeleteAccountDialog({ visible, onCancel, onConfirm }: DeleteAccountDialogProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Guards against a double tap firing two requests before `pending` re-renders.
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Every opening starts from a blank, error-free form.
  useEffect(() => {
    if (!visible) {
      setConfirmation("");
      setError(null);
      setPending(false);
      pendingRef.current = false;
    }
  }, [visible]);

  const canConfirm = confirmation.trim() === ACCOUNT_DELETE_CONFIRMATION && !pending;

  const handleCancel = () => {
    if (pendingRef.current) return;
    onCancel();
  };

  const handleConfirm = async () => {
    if (pendingRef.current || confirmation.trim() !== ACCOUNT_DELETE_CONFIRMATION) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);

    let result: AccountDeletionResult;
    try {
      result = await onConfirm();
    } catch (err) {
      console.error("Account deletion request threw:", err);
      result = { status: "failed", httpStatus: 0 };
    }

    // On success the signed-out session unmounts this screen; nothing to update.
    if (result.status === "ok" || !mountedRef.current) return;

    pendingRef.current = false;
    setPending(false);
    setError(describeAccountDeletionFailure(result));
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
      testID="delete-account-dialog"
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.backdrop} />
        <View
          style={styles.card}
          accessibilityViewIsModal
          accessibilityLabel="Delete account confirmation"
        >
          <Text style={styles.title} accessibilityRole="header">
            Delete account?
          </Text>
          <Text style={styles.warning}>
            This permanently deletes your Drafto account and all of your notebooks, notes and
            attachments. This cannot be undone.
          </Text>

          <Input
            label={CONFIRM_PROMPT}
            accessibilityLabel={CONFIRM_PROMPT}
            value={confirmation}
            onChangeText={setConfirmation}
            placeholder={ACCOUNT_DELETE_CONFIRMATION}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            editable={!pending}
            testID="delete-account-input"
          />

          {error ? (
            <View
              style={styles.errorContainer}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              testID="delete-account-error"
            >
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button
              title="Cancel"
              variant="secondary"
              onPress={handleCancel}
              disabled={pending}
              style={styles.action}
              testID="delete-account-cancel"
            />
            <Button
              title="Delete account"
              variant="danger"
              onPress={handleConfirm}
              disabled={!canConfirm}
              loading={pending}
              style={styles.action}
              testID="delete-account-confirm"
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: "center",
      padding: spacing.lg,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.black,
      opacity: 0.5,
    },
    card: {
      backgroundColor: semantic.bg,
      borderRadius: radii.lg,
      padding: spacing.xl,
      gap: spacing.md,
    },
    title: {
      fontSize: fontSizes["2xl"],
      fontWeight: "700",
      color: semantic.fg,
    },
    warning: {
      fontSize: fontSizes.base,
      lineHeight: 20,
      color: semantic.fgMuted,
    },
    errorContainer: {
      backgroundColor: semantic.errorBg,
      borderWidth: 1,
      borderColor: semantic.errorBorder,
      borderRadius: radii.md,
      padding: spacing.md,
    },
    errorText: {
      fontSize: fontSizes.base,
      color: semantic.errorText,
    },
    actions: {
      flexDirection: "row",
      gap: spacing.sm,
      marginTop: spacing.xs,
    },
    action: {
      flex: 1,
    },
  });
