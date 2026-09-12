import { useState, useMemo } from "react";
import { Text, View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Link } from "expo-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { RECOVERY_REDIRECT_URL } from "@/lib/auth-recovery";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const OFFLINE_MESSAGE = "You're offline. Reconnect to the internet and try again.";

export default function ForgotPasswordScreen() {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const { isConnected } = useNetworkStatus();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    const trimmed = email.trim();

    if (!trimmed) {
      setRetryable(false);
      setError("Please enter your email address.");
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
        setError(resetError.message);
        return;
      }

      setSentTo(trimmed);
    } catch {
      // A thrown request is a transport failure (DNS, timeout, dropped Wi-Fi) —
      // offer the same retry rather than a dead end.
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
        <Link href="/(auth)/login" style={styles.link}>
          Back to login
        </Link>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Forgot Password</Text>
        <Text style={styles.subtitle}>We&apos;ll email you a link to set a new password</Text>

        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <View style={styles.form}>
          <Input
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
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
          <Link href="/(auth)/login" style={styles.link}>
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
