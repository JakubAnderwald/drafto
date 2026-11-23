import { useState, useMemo } from "react";
import { Text, View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Link } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import { describeAuthError, validateEmailField } from "@drafto/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { useOfflineBannerHeight } from "@/hooks/use-offline-banner-height";
import { RECOVERY_REDIRECT_URL } from "@/lib/auth-recovery";
import { useErrorAnnouncement } from "@/hooks/use-error-announcement";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const OFFLINE_MESSAGE = "You're offline. Reconnect to the internet and try again.";

export default function ForgotPasswordScreen() {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  // The keyboard is in window coordinates, so the offset is everything above this
  // view: the header (kept for its Back button) and, while offline, the banner below it.
  const keyboardOffset = useHeaderHeight() + useOfflineBannerHeight();
  const { isConnected } = useNetworkStatus();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [retryable, setRetryable] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by every submit, so an error that repeats the last one's words is still announced
  // to VoiceOver (PrimeTestLab 11035 review).
  const [submitAttempt, setSubmitAttempt] = useState(0);
  useErrorAnnouncement(error, submitAttempt);

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setEmailError(undefined);
  };

  const handleSubmit = async () => {
    setSubmitAttempt((attempt) => attempt + 1);
    const trimmed = email.trim();

    // An empty or malformed address is refused here, under the field (PrimeTestLab 11035 M-02).
    // Set in the same batch as the attempt bump, so a field error left by the last try (one the
    // server sent) is cleared now rather than spoken again while this request is in flight.
    const invalid = validateEmailField(email);
    setEmailError(invalid);
    if (invalid) {
      setRetryable(false);
      setError(null);
      return;
    }

    // Offline is a retry, not a failure — the request never left the device.
    if (!isConnected) {
      setRetryable(true);
      setError(OFFLINE_MESSAGE);
      return;
    }

    setError(null);
    setRetryable(false);
    setLoading(true);

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: RECOVERY_REDIRECT_URL,
      });

      if (resetError) {
        const copy = describeAuthError(resetError);
        if (copy.field === "email") setEmailError(copy.message);
        else setError(copy.message);
        return;
      }

      setSentTo(trimmed);
    } catch (err) {
      // A thrown request is a transport failure (DNS, timeout, dropped Wi-Fi) —
      // offer the same retry rather than a dead end.
      console.error("Password reset request failed:", err);
      setRetryable(true);
      setError(OFFLINE_MESSAGE);
    } finally {
      setLoading(false);
    }
  };

  if (sentTo) {
    return (
      <View style={styles.confirmationContainer}>
        <Text style={styles.title}>Check Your Email</Text>
        <Text style={styles.confirmationText}>
          We&apos;ve sent a password reset link to <Text style={styles.strong}>{sentTo}</Text>. Open
          it on this device to set a new password.
        </Text>
        <Link href="/(auth)/login" dismissTo style={styles.link}>
          Back to login
        </Link>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={keyboardOffset}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Forgot Password</Text>
        <Text style={styles.subtitle}>We&apos;ll email you a link to set a new password</Text>

        {error && (
          <View
            style={styles.errorContainer}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            testID="forgot-password-error"
          >
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.form}>
          <Input
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={handleEmailChange}
            errorText={emailError}
            submitAttempt={submitAttempt}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!loading}
            onSubmitEditing={handleSubmit}
            testID="forgot-password-email-input"
            containerStyle={styles.field}
          />

          <Button
            title={retryable ? "Try again" : "Send reset link"}
            onPress={handleSubmit}
            loading={loading}
            disabled={loading}
            fullWidth
            size="lg"
            testID="forgot-password-submit"
            style={styles.submitButton}
          />
        </View>

        <View style={styles.footer}>
          <Link href="/(auth)/login" dismissTo style={styles.link}>
            Back to login
          </Link>
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
    confirmationContainer: {
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
    confirmationText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
      textAlign: "center",
      marginBottom: spacing["2xl"],
    },
    strong: {
      color: semantic.fg,
      fontWeight: "600",
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
      marginTop: spacing["2xl"],
    },
    link: {
      color: colors.primary[600],
      fontWeight: "600",
      fontSize: fontSizes.base,
    },
  });
