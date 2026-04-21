import { useState, useMemo } from "react";
import { Text, View, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Link, router } from "expo-router";

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

  const handleSignup = async () => {
    if (!email.trim() || !password) {
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
      const { error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      router.replace("/(auth)/waiting-for-approval");
    } finally {
      setLoading(false);
    }
  };

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
            style={styles.submitButton}
          />
        </View>

        <OAuthButtons onError={(msg) => setError(msg)} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Already have an account?{" "}
            <Link href="/(auth)/login" style={styles.link}>
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
    title: {
      fontSize: fontSizes["4xl"],
      fontWeight: "bold",
      marginBottom: spacing.sm,
      color: semantic.fg,
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
    },
  });
