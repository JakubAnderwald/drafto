import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";

import { pickImage, pickDocument, queueAttachment } from "@/lib/data";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

interface AttachmentPickerProps {
  noteId: string;
  onUploadComplete?: () => void;
}

export function AttachmentPicker({ noteId, onUploadComplete }: AttachmentPickerProps) {
  const { user } = useAuth();
  const { sync } = useDatabase();
  const { isConnected } = useNetworkStatus();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [uploading, setUploading] = useState(false);

  const handlePick = async (picker: typeof pickImage | typeof pickDocument) => {
    if (!user || uploading) return;

    try {
      const file = await picker();
      if (!file) return;

      setUploading(true);

      // Always save locally first, then try uploading
      await queueAttachment(user.id, noteId, file);

      if (isConnected) {
        // Trigger sync to upload immediately
        await sync();
      }

      onUploadComplete?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to attach file";
      Alert.alert("Attachment Error", message);
    } finally {
      setUploading(false);
    }
  };

  if (uploading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="small" color={colors.primary[600]} />
        <Text style={styles.uploadingText}>Saving...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.button}
        onPress={() => handlePick(pickImage)}
        accessibilityLabel="Attach image"
        accessibilityRole="button"
      >
        <Text style={styles.buttonIcon}>🖼</Text>
        <Text style={styles.buttonText}>Image</Text>
      </Pressable>
      <Pressable
        style={styles.button}
        onPress={() => handlePick(pickDocument)}
        accessibilityLabel="Attach file"
        accessibilityRole="button"
      >
        <Text style={styles.buttonIcon}>📎</Text>
        <Text style={styles.buttonText}>File</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: semantic.border,
      backgroundColor: semantic.bg,
    },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      backgroundColor: colors.primary[50],
    },
    buttonIcon: {
      fontSize: fontSizes.base,
    },
    buttonText: {
      fontSize: fontSizes.base,
      fontWeight: "500",
      color: colors.primary[600],
    },
    uploadingText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
      marginLeft: spacing.sm,
    },
  });
