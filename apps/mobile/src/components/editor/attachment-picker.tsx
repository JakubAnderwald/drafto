import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { storageFullMessage, wouldExceedQuota } from "@drafto/shared";

import {
  fetchStorageUsage,
  pickImage,
  pickDocument,
  queueAttachment,
  uploadAttachment,
} from "@/lib/data";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { useToast } from "@/components/toast";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Attachment } from "@/db";

interface AttachmentPickerProps {
  noteId: string;
  /** Inserts the attachment into the note. Awaited before the picker settles. */
  onAttachmentReady?: (attachment: Attachment) => void | Promise<void>;
}

export function AttachmentPicker({ noteId, onAttachmentReady }: AttachmentPickerProps) {
  const { user } = useAuth();
  const { sync } = useDatabase();
  const { isConnected } = useNetworkStatus();
  const { showToast } = useToast();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [uploading, setUploading] = useState(false);

  const handlePick = async (picker: typeof pickImage | typeof pickDocument) => {
    if (!user || uploading) return;

    try {
      const file = await picker();
      if (!file) return;

      setUploading(true);

      // A full account (issue #794) is told so up front, instead of saving a file
      // the server will refuse. Offline, or when usage can't be read, the upload
      // queue's own check and the database decide.
      if (isConnected) {
        const usage = await fetchStorageUsage();
        if (usage && wouldExceedQuota(usage, file.fileSize)) {
          showToast(storageFullMessage(usage.usedBytes, usage.quotaBytes), "warning");
          return;
        }
      }

      // Always save locally first, so the file survives a failed or offline upload.
      const attachment = await queueAttachment(user.id, noteId, file);

      // Upload just this file rather than awaiting a full sync. A sync also
      // pushes and pulls every table before returning, which left the note body
      // empty for seconds; and when a sync was already running it returned at
      // once, so "Attachment uploaded" showed for a file that hadn't uploaded.
      const uploaded = isConnected ? await uploadAttachment(attachment) : false;

      // Refused for the storage quota: it never reaches the server and is never
      // retried, so the note doesn't reference it (same as desktop).
      if (!attachment.isStorageFull) {
        await onAttachmentReady?.(attachment);
      }

      // Retry anything still queued (e.g. this file, if its upload failed) and
      // push, without holding up the editor. The editor also syncs after writing
      // the note; concurrent sync() calls coalesce in the database provider.
      void sync();

      if (uploaded) {
        showToast("Attachment uploaded", "success");
      } else if (attachment.isStorageFull) {
        // Refused for the storage quota: not retried, so don't promise a retry.
        showToast(attachment.uploadError ?? storageFullMessage(null, null), "warning");
      } else if (isConnected) {
        showToast("Upload failed — will retry automatically", "warning");
      } else {
        showToast("Attachment saved — will upload when online", "info");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to attach file";
      if (message.includes("Permission")) {
        Alert.alert("Permission Required", message);
      } else {
        showToast(message, "warning");
      }
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
        <Ionicons name="image-outline" size={20} color={colors.primary[600]} />
        <Text style={styles.buttonText}>Image</Text>
      </Pressable>
      <Pressable
        style={styles.button}
        onPress={() => handlePick(pickDocument)}
        accessibilityLabel="Attach file"
        accessibilityRole="button"
      >
        <Ionicons name="document-outline" size={20} color={colors.primary[600]} />
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
