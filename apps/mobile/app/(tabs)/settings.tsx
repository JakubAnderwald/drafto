import { Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { SyncStatus } from "@/components/sync-status";
import { useAuth } from "@/providers/auth-provider";

export default function SettingsScreen() {
  const { signOut } = useAuth();

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Text style={styles.sectionTitle}>Sync</Text>
      <SyncStatus />

      <Text style={styles.sectionTitle}>Account</Text>
      <Pressable style={styles.signOutButton} onPress={signOut}>
        <Ionicons name="log-out-outline" size={20} color="#ef4444" />
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: "#f5f5f4",
  },
  container: {
    padding: 16,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#78716c",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
    marginLeft: 4,
  },
  signOutButton: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    gap: 12,
  },
  signOutText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ef4444",
  },
});
