import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { getSignedUrl, deleteAttachment as deleteAttachmentApi } from "@/lib/data";
import { useDatabase } from "@/providers/database-provider";
import { useToast } from "@/components/toast";
import { colors, semantic } from "@/theme/tokens";
import type { Attachment } from "@/db";

interface AttachmentListProps {
  attachments: Attachment[];
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentItemProps {
  attachment: Attachment;
  onDelete: (attachment: Attachment) => void;
}

function AttachmentItem({ attachment, onDelete }: AttachmentItemProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [imageError, setImageError] = useState(false);
  const isImage = isImageMimeType(attachment.mimeType);
  const isPending = attachment.isPendingUpload;

  // Use local URI for pending attachments, fetch signed URL for uploaded ones
  const displayUri = isPending ? attachment.localUri : signedUrl;

  useEffect(() => {
    if (isPending) return; // No need to fetch URL for pending attachments

    let cancelled = false;

    async function fetchUrl() {
      setLoadingUrl(true);
      try {
        const url = await getSignedUrl(attachment.filePath);
        if (!cancelled) setSignedUrl(url);
      } catch {
        // URL fetch failed - item still shows with filename
      } finally {
        if (!cancelled) setLoadingUrl(false);
      }
    }

    fetchUrl();
    return () => {
      cancelled = true;
    };
  }, [attachment.filePath, isPending]);

  const handlePress = useCallback(async () => {
    if (isPending && attachment.localUri) {
      // Open local file for pending attachments
      try {
        await Linking.openURL(attachment.localUri);
      } catch {
        // Failed to open local file
      }
      return;
    }
    if (!signedUrl) return;
    try {
      await Linking.openURL(signedUrl);
    } catch {
      // Failed to open URL
    }
  }, [signedUrl, isPending, attachment.localUri]);

  const handleDelete = useCallback(() => {
    onDelete(attachment);
  }, [attachment, onDelete]);

  if (isImage) {
    return (
      <View style={styles.imageItem}>
        {!isPending && loadingUrl ? (
          <View style={styles.imagePlaceholder}>
            <ActivityIndicator size="small" color={colors.primary[600]} />
          </View>
        ) : displayUri && !imageError ? (
          <Pressable onPress={handlePress} accessibilityLabel={`Open ${attachment.fileName}`}>
            <Image
              source={{ uri: displayUri }}
              style={styles.imagePreview}
              resizeMode="cover"
              onError={() => setImageError(true)}
              accessibilityLabel={attachment.fileName}
            />
          </Pressable>
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="image-outline" size={24} color={colors.neutral[400]} />
          </View>
        )}
        <View style={styles.imageFooter}>
          <View style={styles.fileNameRow}>
            {isPending && <PendingBadge />}
            <Text style={styles.imageFileName} numberOfLines={1}>
              {attachment.fileName}
            </Text>
          </View>
          <Pressable
            onPress={handleDelete}
            hitSlop={8}
            accessibilityLabel={`Delete ${attachment.fileName}`}
            accessibilityRole="button"
          >
            <Ionicons name="trash-outline" size={16} color={colors.neutral[400]} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      style={styles.fileItem}
      onPress={handlePress}
      disabled={!isPending && !signedUrl}
      accessibilityLabel={`Open ${attachment.fileName}`}
      accessibilityRole="link"
    >
      <Ionicons name="document-outline" size={24} color={colors.primary[600]} />
      <View style={styles.fileInfo}>
        <View style={styles.fileNameRow}>
          {isPending && <PendingBadge />}
          <Text style={styles.fileFileName} numberOfLines={1}>
            {attachment.fileName}
          </Text>
        </View>
        <Text style={styles.fileMeta}>{formatFileSize(attachment.fileSize)}</Text>
      </View>
      <Pressable
        onPress={handleDelete}
        hitSlop={8}
        accessibilityLabel={`Delete ${attachment.fileName}`}
        accessibilityRole="button"
      >
        <Ionicons name="trash-outline" size={16} color={colors.neutral[400]} />
      </Pressable>
    </Pressable>
  );
}

function PendingBadge() {
  return (
    <View style={styles.pendingBadge}>
      <Ionicons name="cloud-upload-outline" size={10} color={colors.warning} />
      <Text style={styles.pendingText}>Pending</Text>
    </View>
  );
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const { database, sync } = useDatabase();
  const { showToast } = useToast();

  const handleDelete = useCallback(
    (attachment: Attachment) => {
      Alert.alert("Delete Attachment", `Delete "${attachment.fileName}"?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              // Only delete from Supabase if already uploaded
              if (!attachment.isPendingUpload) {
                await deleteAttachmentApi(attachment.remoteId, attachment.filePath);
              }
              await database.write(async () => {
                await attachment.markAsDeleted();
              });
              await sync();
              showToast("Attachment deleted", "success");
            } catch (err) {
              showToast(
                err instanceof Error ? err.message : "Failed to delete attachment",
                "warning",
              );
            }
          },
        },
      ]);
    },
    [database, sync, showToast],
  );

  if (attachments.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Attachments</Text>
      <FlatList
        data={attachments}
        keyExtractor={(item) => item.id}
        horizontal={false}
        scrollEnabled={false}
        renderItem={({ item }) => <AttachmentItem attachment={item} onDelete={handleDelete} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    backgroundColor: semantic.bg,
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: semantic.fgMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  imageItem: {
    marginHorizontal: 16,
    marginVertical: 4,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: semantic.bgMuted,
  },
  imagePlaceholder: {
    height: 160,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: semantic.bgMuted,
  },
  imagePreview: {
    width: "100%",
    height: 160,
    borderRadius: 8,
  },
  imageFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  imageFileName: {
    flex: 1,
    fontSize: 12,
    color: semantic.fgMuted,
    marginRight: 8,
  },
  fileItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginVertical: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: semantic.bgMuted,
  },
  fileInfo: {
    flex: 1,
  },
  fileFileName: {
    fontSize: 14,
    fontWeight: "500",
    color: semantic.fg,
    flex: 1,
  },
  fileMeta: {
    fontSize: 12,
    color: semantic.fgSubtle,
    marginTop: 2,
  },
  fileNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pendingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: colors.accent[50],
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  pendingText: {
    fontSize: 10,
    fontWeight: "600",
    color: colors.warning,
  },
});
