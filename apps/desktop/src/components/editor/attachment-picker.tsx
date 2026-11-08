import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { storageFullMessage, wouldExceedQuota } from "@drafto/shared";

import { fetchStorageUsage, pickImage, pickDocument, queueAttachment } from "@/lib/data";
import { STORAGE_FULL_ALERT_TITLE, showStorageFullAlert } from "@/lib/storage-full-alert";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Attachment } from "@/db";

interface AttachmentPickerProps {
  noteId: string;
  onAttachmentReady?: (attachment: Attachment) => void;
}

export function AttachmentPicker({ noteId, onAttachmentReady }: AttachmentPickerProps) {
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

      // Storage quota pre-check (issue #794): a file that can't fit is never saved or
      // queued. Unknown usage skips it; the server refuses the upload either way.
      if (isConnected) {
        const usage = await fetchStorageUsage();
        if (usage && wouldExceedQuota(usage, file.fileSize)) {
          Alert.alert(
            STORAGE_FULL_ALERT_TITLE,
            storageFullMessage(usage.usedBytes, usage.quotaBytes),
          );
          return;
        }
      }

      // Always save locally first, then try uploading
      const attachment = await queueAttachment(user.id, noteId, file);

      if (isConnected) {
        // Trigger sync to upload immediately
        await sync();

        if (attachment.isStorageFull) {
          // Refused for the quota: it never reaches the server and is never retried,
          // so the note doesn't reference it.
          showStorageFullAlert(attachment.uploadError ?? storageFullMessage(undefined, undefined));
          return;
        }
      }

      onAttachmentReady?.(attachment);
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
