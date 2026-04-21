import { useState, useMemo } from "react";
import { Text, View, StyleSheet } from "react-native";

import { useAuth } from "@/providers/auth-provider";
import { useTheme } from "@/providers/theme-provider";
import type { SemanticColors } from "@/theme/tokens";
import { Button } from "@/components/ui/button";

export function WaitingForApprovalScreen() {
  const { signOut, refreshApprovalStatus } = useAuth();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckApproval = async () => {
    setError(null);
    setChecking(true);

    try {
      const approved = await refreshApprovalStatus();
      if (!approved) {
        setError("Your account is still pending approval.");
      }
      // If approved, the route guard will redirect automatically.
    } catch {
      setError("Unable to check approval status. Please try again.");
    } finally {
      setChecking(false);
    }
  };

  const handleSignOut = async () => {
    setSigningOut(true);

    try {
      await signOut();
      // Navigation is handled by the auth provider via onAuthStateChange
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.icon}>&#9203;</Text>
      <Text style={styles.title}>Awaiting Approval</Text>
      <Text style={styles.subtitle}>
        Your account has been created and is pending admin approval. You will be able to access
        Drafto once an admin approves your account.
      </Text>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.buttonContainer}>
        <Button
          title="Check approval status"
          onPress={handleCheckApproval}
          loading={checking}
          disabled={checking || signingOut}
          fullWidth
          size="lg"
          style={styles.primaryButton}
        />

        <Button
          title="Sign out"
          onPress={handleSignOut}
          loading={signingOut}
          disabled={checking || signingOut}
          variant="secondary"
          fullWidth
          size="lg"
        />
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
    icon: {
      fontSize: 48,
      marginBottom: 16,
    },
    title: {
      fontSize: 28,
      fontWeight: "bold",
      marginBottom: 12,
      color: semantic.fg,
    },
    subtitle: {
      fontSize: 16,
      color: semantic.fgMuted,
      textAlign: "center",
      lineHeight: 24,
      marginBottom: 32,
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
    buttonContainer: {
      width: "100%",
    },
    primaryButton: {
      marginBottom: 12,
    },
  });
