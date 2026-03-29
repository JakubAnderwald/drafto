import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { DatabaseProvider } from "@/providers/database-provider";

function AppContent() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Drafto</Text>
      <Text style={styles.subtitle}>macOS Desktop App</Text>
    </View>
  );
}

export function App() {
  return (
    <DatabaseProvider>
      <AppContent />
    </DatabaseProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#1A1A2E",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#6B7280",
  },
});
