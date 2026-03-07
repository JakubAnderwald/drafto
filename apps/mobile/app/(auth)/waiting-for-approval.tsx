import { useState } from "react";
import { Text, View, Pressable, StyleSheet, ActivityIndicator } from "react-native";

import { useAuth } from "@/providers/auth-provider";

export default function WaitingForApprovalScreen() {
  const { signOut, refreshApprovalStatus } = useAuth();
  const [checking, setChecking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckApproval = async () => {
    setError(null);
    setChecking(true);

    try {
      await refreshApprovalStatus();
      // Navigation is handled by the protected route guard (task 2.5).
      // For now, show a message if still not approved.
      setError("Your account is still pending approval.");
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
          <ActivityIndicator color="#fff" />
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
          <ActivityIndicator color="#4f46e5" />
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
    color: "#666",
    textAlign: "center",
    lineHeight: 24,
    marginBottom: 32,
  },
  errorContainer: {
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
    borderRadius: 8,
    padding: 12,
    width: "100%",
    marginBottom: 16,
  },
  errorText: {
    color: "#dc2626",
    fontSize: 14,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#4f46e5",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    width: "100%",
    marginBottom: 12,
  },
  buttonPressed: {
    backgroundColor: "#4338ca",
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    width: "100%",
  },
  signOutButtonPressed: {
    backgroundColor: "#f3f4f6",
  },
  signOutButtonText: {
    color: "#4f46e5",
    fontSize: 16,
    fontWeight: "600",
  },
});
