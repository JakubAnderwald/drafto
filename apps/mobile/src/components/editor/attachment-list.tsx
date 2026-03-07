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

  useEffect(() => {
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
  }, [attachment.filePath]);

  const handlePress = useCallback(async () => {
    if (!signedUrl) return;
    try {
      await Linking.openURL(signedUrl);
    } catch {
      // Failed to open URL
    }
  }, [signedUrl]);

  const handleDelete = useCallback(() => {
    onDelete(attachment);
  }, [attachment, onDelete]);

  if (isImage) {
    return (
      <View style={styles.imageItem}>
        {loadingUrl ? (
          <View style={styles.imagePlaceholder}>
            <ActivityIndicator size="small" color="#4f46e5" />
          </View>
        ) : signedUrl && !imageError ? (
          <Pressable onPress={handlePress} accessibilityLabel={`Open ${attachment.fileName}`}>
            <Image
              source={{ uri: signedUrl }}
              style={styles.imagePreview}
              resizeMode="cover"
              onError={() => setImageError(true)}
              accessibilityLabel={attachment.fileName}
            />
          </Pressable>
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="image-outline" size={24} color="#9ca3af" />
          </View>
        )}
        <View style={styles.imageFooter}>
          <Text style={styles.imageFileName} numberOfLines={1}>
            {attachment.fileName}
          </Text>
          <Pressable
            onPress={handleDelete}
            hitSlop={8}
            accessibilityLabel={`Delete ${attachment.fileName}`}
            accessibilityRole="button"
          >
            <Ionicons name="trash-outline" size={16} color="#9ca3af" />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      style={styles.fileItem}
      onPress={handlePress}
      disabled={!signedUrl}
      accessibilityLabel={`Open ${attachment.fileName}`}
      accessibilityRole="link"
    >
      <Ionicons name="document-outline" size={24} color="#4f46e5" />
      <View style={styles.fileInfo}>
        <Text style={styles.fileFileName} numberOfLines={1}>
          {attachment.fileName}
        </Text>
        <Text style={styles.fileMeta}>{formatFileSize(attachment.fileSize)}</Text>
      </View>
      <Pressable
        onPress={handleDelete}
        hitSlop={8}
        accessibilityLabel={`Delete ${attachment.fileName}`}
        accessibilityRole="button"
      >
        <Ionicons name="trash-outline" size={16} color="#9ca3af" />
      </Pressable>
    </Pressable>
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
              await deleteAttachmentApi(attachment.remoteId, attachment.filePath);
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
    borderTopColor: "#e5e7eb",
    backgroundColor: "#fff",
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6b7280",
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
    backgroundColor: "#f3f4f6",
  },
  imagePlaceholder: {
    height: 160,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f3f4f6",
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
    color: "#6b7280",
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
    backgroundColor: "#f3f4f6",
  },
  fileInfo: {
    flex: 1,
  },
  fileFileName: {
    fontSize: 14,
    fontWeight: "500",
    color: "#111827",
  },
  fileMeta: {
    fontSize: 12,
    color: "#9ca3af",
    marginTop: 2,
  },
});
