import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  FlatList,
} from "react-native";

import { getSignedUrl, deleteAttachment as deleteAttachmentApi, openAttachment } from "@/lib/data";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { Badge } from "@/components/ui/badge";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
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
  onRetry: () => void;
  styles: ReturnType<typeof createStyles>;
}

function AttachmentItem({ attachment, onDelete, onRetry, styles }: AttachmentItemProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const isImage = isImageMimeType(attachment.mimeType);
  const isPending = attachment.isPendingUpload;
  const hasFailed = attachment.hasFailed;
  const isLocal = isPending || hasFailed;

  const displayUri = isLocal ? attachment.localUri : signedUrl;

  useEffect(() => {
    if (isLocal) return;

    let cancelled = false;

    async function fetchUrl() {
      setLoadingUrl(true);
      setUrlError(false);
      try {
        const url = await getSignedUrl(attachment.filePath);
        if (!cancelled) setSignedUrl(url);
      } catch {
        if (!cancelled) setUrlError(true);
      } finally {
        if (!cancelled) setLoadingUrl(false);
      }
    }

    fetchUrl();
    return () => {
      cancelled = true;
    };
  }, [attachment.filePath, isLocal]);

  const handlePress = useCallback(async () => {
    if (hasFailed) {
      onRetry();
      return;
    }

    if (!isPending && urlError) {
      setLoadingUrl(true);
      setUrlError(false);
      try {
        const url = await getSignedUrl(attachment.filePath);
        setSignedUrl(url);
        setLoadingUrl(false);
        await openAttachment({ signedUrl: url, localUri: null, isPending: false });
      } catch {
        setUrlError(true);
        setLoadingUrl(false);
      }
      return;
    }

    await openAttachment({
      signedUrl,
      localUri: attachment.localUri,
      isPending,
    });
  }, [
    signedUrl,
    isPending,
    hasFailed,
    attachment.localUri,
    attachment.filePath,
    urlError,
    onRetry,
  ]);

  const handleDelete = useCallback(() => {
    onDelete(attachment);
  }, [attachment, onDelete]);

  if (isImage) {
    return (
      <View style={styles.imageItem}>
        {!isLocal && loadingUrl ? (
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
        ) : urlError || hasFailed ? (
          <Pressable onPress={handlePress} style={styles.imagePlaceholder}>
            <Text style={styles.retryIcon}>↻</Text>
            <Text style={styles.retryHint}>Click to retry</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handlePress}
            style={styles.imagePlaceholder}
            accessibilityLabel={`Open ${attachment.fileName}`}
          >
            <Text style={styles.placeholderIcon}>🖼</Text>
            {imageError && <Text style={styles.retryHint}>Click to open</Text>}
          </Pressable>
        )}
        <View style={styles.imageFooter}>
          <View style={styles.fileNameRow}>
            {isPending && <PendingBadge />}
            {hasFailed && <FailedBadge />}
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
            <Text style={styles.deleteIcon}>🗑</Text>
          </Pressable>
        </View>
        {hasFailed && attachment.uploadError && (
          <Text style={styles.errorText} numberOfLines={2}>
            {attachment.uploadError}
          </Text>
        )}
      </View>
    );
  }

  const fileMeta = hasFailed
    ? (attachment.uploadError ?? "Upload failed — click to retry")
    : urlError
      ? "Click to retry"
      : formatFileSize(attachment.fileSize);

  return (
    <Pressable
      style={styles.fileItem}
      onPress={handlePress}
      disabled={!isLocal && !signedUrl && !urlError && loadingUrl}
      accessibilityLabel={
        hasFailed ? `Retry upload of ${attachment.fileName}` : `Open ${attachment.fileName}`
      }
      accessibilityRole={hasFailed ? "button" : "link"}
    >
      <Text style={styles.fileIcon}>{hasFailed || urlError ? "↻" : "📄"}</Text>
      <View style={styles.fileInfo}>
        <View style={styles.fileNameRow}>
          {isPending && <PendingBadge />}
          {hasFailed && <FailedBadge />}
          <Text style={styles.fileFileName} numberOfLines={1}>
            {attachment.fileName}
          </Text>
        </View>
        <Text style={hasFailed ? styles.errorText : styles.fileMeta} numberOfLines={2}>
          {fileMeta}
        </Text>
      </View>
      <Pressable
        onPress={handleDelete}
        hitSlop={8}
        accessibilityLabel={`Delete ${attachment.fileName}`}
        accessibilityRole="button"
      >
        <Text style={styles.deleteIcon}>🗑</Text>
      </Pressable>
    </Pressable>
  );
}

function PendingBadge() {
  return (
    <View style={pendingStyles.pendingBadge}>
      <Text style={pendingStyles.pendingIcon}>☁</Text>
      <Text style={pendingStyles.pendingText}>Pending</Text>
    </View>
  );
}

function FailedBadge() {
  return <Badge label="Failed" variant="error" />;
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const { database, sync } = useDatabase();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const handleRetry = useCallback(() => {
    sync().catch((err) => {
      console.warn("[AttachmentList] Retry sync failed:", err);
    });
  }, [sync]);

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
              if (attachment.uploadStatus === "uploaded") {
                await deleteAttachmentApi(attachment.remoteId, attachment.filePath);
              }
              await database.write(async () => {
                await attachment.markAsDeleted();
              });
              await sync();
            } catch (err) {
              Alert.alert(
                "Error",
                err instanceof Error ? err.message : "Failed to delete attachment",
              );
            }
          },
        },
      ]);
    },
    [database, sync],
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
        renderItem={({ item }) => (
          <AttachmentItem
            attachment={item}
            onDelete={handleDelete}
            onRetry={handleRetry}
            styles={styles}
          />
        )}
      />
    </View>
  );
}

const pendingStyles = StyleSheet.create({
  pendingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing["2xs"],
    backgroundColor: colors.secondary[50],
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing["2xs"],
  },
  pendingIcon: {
    fontSize: fontSizes.xs,
    color: colors.warning,
  },
  pendingText: {
    fontSize: fontSizes.xs,
    fontWeight: "600",
    color: colors.warning,
  },
});

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: semantic.border,
      backgroundColor: semantic.bg,
      paddingVertical: spacing.sm,
    },
    sectionTitle: {
      fontSize: fontSizes.md,
      fontWeight: "600",
      color: semantic.fgMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
    },
    imageItem: {
      marginHorizontal: spacing.lg,
      marginVertical: spacing.xs,
      borderRadius: radii.md,
      overflow: "hidden",
      backgroundColor: semantic.bgMuted,
    },
    imagePlaceholder: {
      height: 160,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: semantic.bgMuted,
    },
    placeholderIcon: {
      // Emoji icon sized as a visual, not typography
      // eslint-disable-next-line no-restricted-syntax -- emoji glyph, not typography
      fontSize: 24,
    },
    retryIcon: {
      // Emoji icon sized as a visual, not typography
      // eslint-disable-next-line no-restricted-syntax -- emoji glyph, not typography
      fontSize: 24,
      color: colors.neutral[400],
    },
    retryHint: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      marginTop: spacing.xs,
    },
    imagePreview: {
      width: "100%",
      height: 160,
      borderRadius: radii.md,
    },
    imageFooter: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    imageFileName: {
      flex: 1,
      fontSize: fontSizes.sm,
      color: semantic.fgMuted,
      marginRight: spacing.sm,
    },
    fileItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginVertical: spacing.xs,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      backgroundColor: semantic.bgMuted,
    },
    fileIcon: {
      // Emoji icon sized as a visual, not typography
      // eslint-disable-next-line no-restricted-syntax -- emoji glyph, not typography
      fontSize: 20,
    },
    fileInfo: {
      flex: 1,
    },
    fileFileName: {
      fontSize: fontSizes.base,
      fontWeight: "500",
      color: semantic.fg,
      flex: 1,
    },
    fileMeta: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      marginTop: spacing["2xs"],
    },
    errorText: {
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      marginTop: spacing["2xs"],
      paddingHorizontal: spacing.sm,
    },
    fileNameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    deleteIcon: {
      fontSize: fontSizes.base,
    },
  });
