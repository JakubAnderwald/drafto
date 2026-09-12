import { useState, useMemo } from "react";
import { ActivityIndicator, Text, View, Pressable, StyleSheet } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/auth-provider";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const MIN_PASSWORD_LENGTH = 6;
const OFFLINE_MESSAGE = "You're offline. Reconnect to the internet and try again.";
const SIGN_OUT_FAILED_MESSAGE = "Couldn't sign out. Check your connection and try again.";

interface ResetPasswordScreenProps {
  onNavigateToLogin?: () => void;
}

export function ResetPasswordScreen({ onNavigateToLogin }: ResetPasswordScreenProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const { session, recoveryError, endRecovery, signOut } = useAuth();
  const { isConnected } = useNetworkStatus();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Backing out of a recovery session must not leave the user silently signed in
  // with a password they never set. If sign-out fails the recovery session is
  // still live, so recovery mode must survive too — ending it would let
  // RootNavigator hand that session straight to the main app.
  const handleBackToLogin = async () => {
    setLeaving(true);
    try {
      if (session) {
        await signOut();
      }
      endRecovery();
      onNavigateToLogin?.();
    } catch (err) {
      console.error("Sign-out while leaving password recovery failed:", err);
      setRetryable(false);
      setError(SIGN_OUT_FAILED_MESSAGE);
    } finally {
      setLeaving(false);
    }
  };

  // A link that failed never replaced the session, so there is nothing orphaned
  // to clean up — dismissing must not sign out whoever was already logged in.
  const handleDismissRecovery = () => {
    endRecovery();
    if (!session) {
      onNavigateToLogin?.();
    }
  };

  const handleSubmit = async () => {
    if (password !== confirmPassword) {
      setRetryable(false);
      setError("Passwords do not match.");
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setRetryable(false);
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (!isConnected) {
      setRetryable(true);
      setError(OFFLINE_MESSAGE);
      return;
    }

    setError(null);
    setRetryable(false);
    setLoading(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      // Keep the (now fully valid) session and let RootNavigator take over — the
      // same landing behaviour as the web flow.
      endRecovery();
    } catch (err) {
      console.error("Password update request failed:", err);
      setRetryable(true);
      setError(OFFLINE_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  // Signing out flushes pending changes and wipes the local database, which can
  // take seconds. Without a state of its own the screen would sit frozen on the
  // form and then flash the "verifying your reset link" spinner below as the
  // session clears mid-flight — both of which read as the app having hung.
  if (leaving) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
        <Text style={styles.messageText}>Signing out…</Text>
      </View>
    );
  }

  if (recoveryError) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Reset Link Problem</Text>
        <Text style={styles.messageText}>{recoveryError}</Text>
        <Button
          title={session ? "Continue" : "Back to login"}
          onPress={handleDismissRecovery}
          variant="secondary"
          fullWidth
          size="lg"
          testID="reset-password-dismiss"
        />
      </View>
    );
  }

  // The link was recognised but the code exchange has not landed yet. There is
  // nothing to update without a session, so waiting is the only correct state.
  if (!session) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
        <Text style={styles.messageText}>Verifying your reset link…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Reset Password</Text>
      <Text style={styles.subtitle}>Choose a new password for your Drafto account</Text>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.form}>
        <View style={styles.field}>
          <Input
            testID="new-password-input"
            label="New Password"
            placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            editable={!loading}
          />
        </View>

        <View style={styles.field}>
          <Input
            testID="confirm-password-input"
            label="Confirm Password"
            placeholder="Re-enter your new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            editable={!loading}
            onSubmitEditing={handleSubmit}
          />
        </View>

        <Button
          title={retryable ? "Try again" : "Reset password"}
          onPress={handleSubmit}
          loading={loading}
          fullWidth
          size="lg"
          testID="reset-password-submit"
        />
      </View>

      <View style={styles.footer}>
        <Pressable onPress={handleBackToLogin} disabled={leaving} testID="reset-password-cancel">
          <Text style={styles.link}>Back to login</Text>
        </Pressable>
      </View>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing["2xl"],
      maxWidth: 400,
      alignSelf: "center",
      width: "100%",
    },
    title: {
      fontSize: fontSizes["4xl"],
      fontWeight: "bold",
      marginBottom: spacing.sm,
      color: semantic.fg,
      textAlign: "center",
    },
    subtitle: {
      fontSize: fontSizes.xl,
      color: semantic.fgMuted,
      marginBottom: spacing["2xl"],
      textAlign: "center",
    },
    messageText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
      textAlign: "center",
      marginTop: spacing.lg,
      marginBottom: spacing["2xl"],
    },
    errorContainer: {
      backgroundColor: semantic.errorBg,
      borderWidth: 1,
      borderColor: semantic.errorBorder,
      borderRadius: radii.md,
      padding: spacing.md,
      width: "100%",
      marginBottom: spacing.lg,
    },
    errorText: {
      color: semantic.errorText,
      fontSize: fontSizes.base,
      textAlign: "center",
    },
    form: {
      width: "100%",
    },
    field: {
      marginBottom: spacing.lg,
    },
    footer: {
      marginTop: spacing["2xl"],
    },
    link: {
      color: colors.primary[600],
      fontWeight: "600",
      fontSize: fontSizes.base,
    },
  });
