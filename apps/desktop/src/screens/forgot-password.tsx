import { useState, useMemo } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { RECOVERY_REDIRECT_URL } from "@/lib/auth-recovery";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

const OFFLINE_MESSAGE = "You're offline. Reconnect to the internet and try again.";

interface ForgotPasswordScreenProps {
  onNavigateToLogin?: () => void;
}

export function ForgotPasswordScreen({ onNavigateToLogin }: ForgotPasswordScreenProps) {
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
      <View style={styles.container}>
        <Text style={styles.title}>Check Your Email</Text>
        <Text style={styles.confirmationText}>
          We&apos;ve sent a password reset link to <Text style={styles.strong}>{sentTo}</Text>. Open
          it on this Mac to set a new password.
        </Text>
        <Pressable onPress={onNavigateToLogin} disabled={!onNavigateToLogin}>
          <Text style={styles.link}>Back to login</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Forgot Password</Text>
      <Text style={styles.subtitle}>We&apos;ll email you a link to set a new password</Text>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.form}>
        <View style={styles.field}>
          <Input
            testID="forgot-password-email-input"
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
          />
        </View>

        <Button
          title={retryable ? "Try again" : "Send reset link"}
          onPress={handleSubmit}
          loading={loading}
          fullWidth
          size="lg"
          testID="forgot-password-submit"
        />
      </View>

      {/* The desktop client uses the PKCE flow, so the code verifier only exists
          in this install — a link opened on another device cannot complete. */}
      <Text style={styles.hint}>
        Open the link on this Mac — it won&apos;t work on another device.
      </Text>

      <View style={styles.footer}>
        <Pressable onPress={onNavigateToLogin} disabled={!onNavigateToLogin}>
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
    hint: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      textAlign: "center",
      marginTop: spacing.lg,
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
