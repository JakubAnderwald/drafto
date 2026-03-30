import { useState, useMemo } from "react";
import { Text, View, TextInput, Pressable, Button, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

interface SignupScreenProps {
  onNavigateToLogin?: () => void;
}

export function SignupScreen({ onNavigateToLogin }: SignupScreenProps) {
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

      // Auth state change will handle navigation to waiting-for-approval
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign Up</Text>
      <Text style={styles.subtitle}>Create your Drafto account</Text>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.form}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={semantic.fgSubtle}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          editable={!loading}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          placeholder="Min. 6 characters"
          placeholderTextColor={semantic.fgSubtle}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password"
          textContentType="newPassword"
          editable={!loading}
          onSubmitEditing={handleSignup}
        />

        <Button
          title={loading ? "Signing up..." : "Sign up"}
          onPress={handleSignup}
          disabled={loading}
          color={colors.primary[600]}
        />
      </View>

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
      padding: 24,
      maxWidth: 400,
      alignSelf: "center",
      width: "100%",
    },
    title: {
      fontSize: 28,
      fontWeight: "bold",
      marginBottom: 8,
      color: semantic.fg,
    },
    subtitle: {
      fontSize: 16,
      color: semantic.fgMuted,
      marginBottom: 24,
    },
    errorContainer: {
      backgroundColor: semantic.errorBg,
      borderWidth: 1,
      borderColor: semantic.errorBorder,
      borderRadius: 8,
      padding: 12,
      width: "100%",
      marginBottom: 16,
    },
    errorText: {
      color: semantic.errorText,
      fontSize: 14,
      textAlign: "center",
    },
    form: {
      width: "100%",
    },
    label: {
      fontSize: 14,
      fontWeight: "600",
      marginBottom: 6,
      color: semantic.fgMuted,
    },
    input: {
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: 8,
      padding: 12,
      fontSize: 16,
      marginBottom: 16,
      backgroundColor: semantic.bg,
      color: semantic.fg,
    },
    button: {
      backgroundColor: colors.primary[600],
      borderRadius: 8,
      padding: 14,
      alignItems: "center",
      marginTop: 8,
    },
    buttonPressed: {
      backgroundColor: colors.primary[700],
    },
    buttonDisabled: {
      opacity: 0.7,
    },
    buttonText: {
      color: semantic.onPrimary,
      fontSize: 16,
      fontWeight: "600",
    },
    footer: {
      marginTop: 24,
    },
    footerText: {
      fontSize: 14,
      color: semantic.fgMuted,
    },
    link: {
      color: colors.primary[600],
      fontWeight: "600",
    },
  });
