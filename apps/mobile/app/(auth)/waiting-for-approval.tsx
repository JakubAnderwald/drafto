import { useState } from "react";
import { Text, View, Pressable, StyleSheet, ActivityIndicator } from "react-native";

import { useAuth } from "@/providers/auth-provider";
import { colors, semantic } from "@/theme/tokens";

export default function WaitingForApprovalScreen() {
  const { signOut, refreshApprovalStatus } = useAuth();
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckApproval = async () => {
    setError(null);
    setChecking(true);

    try {
      const approved = await refreshApprovalStatus();
      // If approved, the route guard will redirect automatically.
      if (!approved) {
        setError("Your account is still pending approval.");
      }
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

      <Pressable
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          checking && styles.buttonDisabled,
        ]}
        onPress={handleCheckApproval}
        disabled={checking || signingOut}
      >
        {checking ? (
          <ActivityIndicator color={semantic.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Check approval status</Text>
        )}
      </Pressable>

      <Pressable
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && styles.signOutButtonPressed,
          signingOut && styles.buttonDisabled,
        ]}
        onPress={handleSignOut}
        disabled={checking || signingOut}
      >
        {signingOut ? (
          <ActivityIndicator color={colors.primary[600]} />
        ) : (
          <Text style={styles.signOutButtonText}>Sign out</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 12,
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
  button: {
    backgroundColor: colors.primary[600],
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    width: "100%",
    marginBottom: 12,
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
  signOutButton: {
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    width: "100%",
  },
  signOutButtonPressed: {
    backgroundColor: semantic.bgMuted,
  },
  signOutButtonText: {
    color: colors.primary[600],
    fontSize: 16,
    fontWeight: "600",
  },
});
