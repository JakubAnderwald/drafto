import { useState, useMemo } from "react";
import { Text, View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Link } from "expo-router";
import { SIGNUP_CONFIRMATION_SENT, SIGNUP_EMAIL_REDIRECT_URL } from "@drafto/shared";

import { supabase } from "@/lib/supabase";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function SignupScreen() {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSignup = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Please enter your email and password.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: { emailRedirectTo: SIGNUP_EMAIL_REDIRECT_URL },
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      // With email confirmation on, sign-up returns no session: the user has to confirm the
      // address first. Navigating anywhere now would only bounce off the route guard, so say
      // what happens next instead. With a session, the auth state change routes the user on.
      if (!data.session) {
        setSentTo(trimmedEmail);
      }
    } finally {
      setLoading(false);
    }
  };

  if (sentTo) {
    return (
      <View style={styles.confirmationContainer} testID="signup-check-email">
        <Text style={styles.title} accessibilityRole="header">
          Check Your Email
        </Text>
        <Text style={styles.sentTo}>{sentTo}</Text>
        <Text style={styles.confirmationText}>{SIGNUP_CONFIRMATION_SENT}</Text>
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
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Sign Up</Text>
        <Text style={styles.subtitle}>Create your Drafto account</Text>

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
            containerStyle={styles.field}
          />

          <Input
            label="Password"
            placeholder="Min. 6 characters"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            textContentType="newPassword"
            editable={!loading}
            onSubmitEditing={handleSignup}
            containerStyle={styles.field}
          />

          <Button
            title="Sign up"
            onPress={handleSignup}
            loading={loading}
            disabled={loading}
            fullWidth
            size="lg"
            accessibilityLabel="Sign up"
            testID="signup-submit"
            style={styles.submitButton}
          />
        </View>

        <OAuthButtons onError={(msg) => setError(msg)} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Already have an account?{" "}
            <Link href="/(auth)/login" dismissTo style={styles.link}>
              Log in
            </Link>
          </Text>
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
    sentTo: {
      fontSize: fontSizes.base,
      fontWeight: "600",
      color: semantic.fg,
      textAlign: "center",
      marginBottom: spacing.md,
    },
    confirmationText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
      textAlign: "center",
      marginBottom: spacing["2xl"],
    },
    subtitle: {
      fontSize: fontSizes.xl,
      color: semantic.fgMuted,
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
      marginTop: spacing["2xl"],
    },
    footerText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
    },
    link: {
      color: colors.primary[600],
      fontWeight: "600",
      fontSize: fontSizes.base,
    },
  });
