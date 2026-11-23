import { useState, useMemo } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
import {
  SIGNUP_CONFIRMATION_SENT,
  SIGNUP_EMAIL_REDIRECT_URL,
  describeAuthError,
  hasFieldErrors,
  validateCredentials,
  type AuthFieldErrors,
} from "@drafto/shared";

import { cryptoReady, supabase } from "@/lib/supabase";
import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

interface SignupScreenProps {
  onNavigateToLogin?: () => void;
}

export function SignupScreen({ onNavigateToLogin }: SignupScreenProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleEmailChange = (value: string) => {
    setEmail(value);
    setFieldErrors((current) => ({ ...current, email: undefined }));
  };

  const handlePasswordChange = (value: string) => {
    setPassword(value);
    setFieldErrors((current) => ({ ...current, password: undefined }));
  };

  const handleSignup = async () => {
    const trimmedEmail = email.trim();
    // Both fields are checked on every submit, so the user sees every problem at once, and a
    // malformed address never reaches Supabase (PrimeTestLab 11035 M-02).
    const validation = validateCredentials({ email, password }, "signup");
    setFieldErrors(validation);
    if (hasFieldErrors(validation)) {
      setError(null);
      return;
    }

    setError(null);
    setLoading(true);

    try {
      // Sign-up starts a PKCE flow too: wait for the S256 crypto (ADR-0062).
      await cryptoReady;
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: { emailRedirectTo: SIGNUP_EMAIL_REDIRECT_URL },
      });

      if (signUpError) {
        const copy = describeAuthError(signUpError);
        if (copy.field) setFieldErrors({ [copy.field]: copy.message });
        else setError(copy.message);
        return;
      }

      // With email confirmation on, sign-up returns no session and no auth event fires, so
      // the navigator has nothing to react to: say what happens next. With a session, the
      // auth state change leads into the app: a new account is active from the start (ADR 0094).
      if (!data.session) {
        setSentTo(trimmedEmail);
      }
    } finally {
      setLoading(false);
    }
  };

  // The form is gone in this state, so it cannot be submitted again for a second email.
  if (sentTo) {
    return (
      <View style={styles.container} testID="signup-check-email">
        <Text style={styles.title} accessibilityRole="header">
          Check Your Email
        </Text>
        <Text style={styles.sentTo}>{sentTo}</Text>
        <Text style={styles.confirmationText}>{SIGNUP_CONFIRMATION_SENT}</Text>
        <Pressable
          onPress={onNavigateToLogin}
          disabled={!onNavigateToLogin}
          accessibilityRole="button"
          accessibilityLabel="Back to login"
        >
          <Text style={styles.link}>Back to login</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign Up</Text>
      <Text style={styles.subtitle}>Create your Drafto account</Text>

      {error && (
        <View style={styles.errorContainer} accessibilityRole="alert" testID="signup-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.form}>
        <View style={styles.field}>
          <Input
            testID="signup-email-input"
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={handleEmailChange}
            errorText={fieldErrors.email}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            editable={!loading}
          />
        </View>

        <View style={styles.field}>
          <PasswordInput
            testID="signup-password-input"
            label="Password"
            placeholder="Min. 6 characters"
            value={password}
            onChangeText={handlePasswordChange}
            errorText={fieldErrors.password}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            editable={!loading}
            onSubmitEditing={handleSignup}
          />
        </View>

        <Button
          title="Sign up"
          onPress={handleSignup}
          loading={loading}
          fullWidth
          size="lg"
          testID="signup-submit"
        />
      </View>

      <OAuthButtons onError={(msg) => setError(msg)} />

      <View style={styles.footer}>
        <Pressable onPress={onNavigateToLogin} disabled={!onNavigateToLogin}>
          <Text style={styles.footerText}>
            Already have an account? <Text style={styles.link}>Log in</Text>
          </Text>
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
