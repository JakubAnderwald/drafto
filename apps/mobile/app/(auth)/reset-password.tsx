import { useState, useMemo } from "react";
import {
  ActivityIndicator,
  Text,
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";

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
const EXPIRED_MESSAGE =
  "This password reset link is invalid or has expired. Request a new one from the login screen.";

export default function ResetPasswordScreen() {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const router = useRouter();
  const { session, isRecovering, recoveryError, endRecovery, signOut } = useAuth();
  const { isConnected } = useNetworkStatus();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Backing out of a recovery session must not leave the user silently signed in
  // with a password they never set.
  const handleBackToLogin = async () => {
    setLeaving(true);
    try {
      if (session) {
        await signOut();
      }
    } finally {
      endRecovery();
      setLeaving(false);
      router.replace("/(auth)/login");
    }
  };

  // A link that failed never replaced the session, so there is nothing orphaned
  // to clean up — dismissing must not sign out whoever was already logged in.
  const handleDismissRecovery = () => {
    endRecovery();
    if (!session) {
      router.replace("/(auth)/login");
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

      // Keep the (now fully valid) session and let the route guard take over —
      // the same landing behaviour as the web flow.
      endRecovery();
    } catch {
      setRetryable(true);
      setError(OFFLINE_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  // Signing out flushes pending changes and wipes the local database, which can
  // take seconds. Without a state of its own the screen would sit on the form and
  // then flash the "verifying your reset link" spinner below as the session clears
  // mid-flight — both of which read as the app having hung.
  if (leaving) {
    return (
      <View style={styles.messageContainer}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
        <Text style={styles.messageText}>Signing out…</Text>
      </View>
    );
  }

  if (recoveryError) {
    return (
      <View style={styles.messageContainer}>
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

  if (!session) {
    // Recovery in flight: the link was recognised but the session round-trip has
    // not landed yet. Without a session there is nothing to update, so waiting is
    // the only correct state.
    if (isRecovering) {
      return (
        <View style={styles.messageContainer}>
          <ActivityIndicator size="large" color={colors.primary[600]} />
          <Text style={styles.messageText}>Verifying your reset link…</Text>
        </View>
      );
    }

    return (
      <View style={styles.messageContainer}>
        <Text style={styles.title}>Reset Link Problem</Text>
        <Text style={styles.messageText}>{EXPIRED_MESSAGE}</Text>
        <Button
          title="Back to login"
          onPress={handleBackToLogin}
          variant="secondary"
          fullWidth
          size="lg"
          testID="reset-password-back-to-login"
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Reset Password</Text>
        <Text style={styles.subtitle}>Choose a new password for your Drafto account</Text>

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.form}>
          <Input
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
            testID="new-password-input"
            containerStyle={styles.field}
          />

          <Input
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
            testID="confirm-password-input"
            containerStyle={styles.field}
          />

          <Button
            title={retryable ? "Try again" : "Reset password"}
            onPress={handleSubmit}
            loading={loading}
            disabled={loading}
            fullWidth
            size="lg"
            testID="reset-password-submit"
            style={styles.submitButton}
          />
        </View>

        <View style={styles.footer}>
          <Button
            title="Back to login"
            onPress={handleBackToLogin}
            variant="ghost"
            fullWidth
            testID="reset-password-back-to-login"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    container: {
      flexGrow: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing["2xl"],
    },
    messageContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: spacing["2xl"],
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
    submitButton: {
      marginTop: spacing.sm,
    },
    footer: {
      marginTop: spacing.lg,
      width: "100%",
    },
  });
