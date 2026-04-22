import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { Ionicons } from "@expo/vector-icons";

import {
  deleteAttachment as deleteAttachmentApi,
  openAttachment,
  getCachedSignedUrl,
  getCachedSignedUrlSync,
  invalidateCachedSignedUrl,
} from "@/lib/data";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useToast } from "@/components/toast";
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

type ShowToast = (message: string, type: "success" | "warning") => void;

interface AttachmentItemProps {
  attachment: Attachment;
  onDelete: (attachment: Attachment) => void;
  onRetry: () => void;
  showToast: ShowToast;
  styles: ReturnType<typeof createStyles>;
}

function AttachmentItem({ attachment, onDelete, onRetry, showToast, styles }: AttachmentItemProps) {
  // Initialise from cache so images that were already resolved render instantly
  const [signedUrl, setSignedUrl] = useState<string | null>(() =>
    getCachedSignedUrlSync(attachment.filePath),
  );
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const isImage = isImageMimeType(attachment.mimeType);
  const isPending = attachment.isPendingUpload;
  const hasFailed = attachment.hasFailed;

  // Preserve the last successfully displayed URI so the image stays visible
  // while transitioning from pending (localUri) to uploaded (signedUrl).
  const lastGoodUri = useRef<string | null>(attachment.localUri ?? signedUrl);

  const currentUri = isPending ? attachment.localUri : signedUrl;
  if (currentUri) {
    lastGoodUri.current = currentUri;
  }

  // Fall back to last known good URI to prevent flash-to-blank during transition
  const displayUri = currentUri ?? lastGoodUri.current;

  // Reset imageError when a new URL becomes available so the Image gets a fresh attempt
  useEffect(() => {
    if (signedUrl) {
      setImageError(false);
    }
  }, [signedUrl]);

  // When an image fails to render, the signed URL may be stale or the file
  // may not have been ready yet. Invalidate the cache and fetch a fresh URL.
  const retryCount = useRef(0);
  useEffect(() => {
    if (!imageError || isPending || retryCount.current >= 2) return;

    retryCount.current += 1;
    let cancelled = false;

    async function refetchUrl() {
      invalidateCachedSignedUrl(attachment.filePath);
      try {
        const url = await getCachedSignedUrl(attachment.filePath);
        if (!cancelled) setSignedUrl(url);
      } catch {
        // Already in error state — leave as-is
      }
    }

    refetchUrl();
    return () => {
      cancelled = true;
    };
  }, [imageError, isPending, attachment.filePath]);

  useEffect(() => {
    if (isPending) return; // No need to fetch URL for pending attachments

    // If the cache already provided a URL, skip the fetch
    if (signedUrl) return;

    let cancelled = false;

    async function fetchUrl() {
      setLoadingUrl(true);
      setUrlError(false);
      try {
        const url = await getCachedSignedUrl(attachment.filePath);
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
  }, [attachment.filePath, isPending, signedUrl]);

  const handlePress = useCallback(async () => {
    if (hasFailed) {
      onRetry();
      showToast("Retrying upload…", "success");
      return;
    }

    // If URL failed to load, retry fetching it (bypass cache)
    if (!isPending && urlError) {
      setLoadingUrl(true);
      setUrlError(false);
      try {
        invalidateCachedSignedUrl(attachment.filePath);
        const url = await getCachedSignedUrl(attachment.filePath);
        setSignedUrl(url);
        setLoadingUrl(false);
        const result = await openAttachment({ signedUrl: url, localUri: null, isPending: false });
        if (result.status === "unavailable") {
          showToast(result.reason, "warning");
        }
      } catch {
        setUrlError(true);
        setLoadingUrl(false);
        showToast("Could not load attachment. Tap to retry.", "warning");
      }
      return;
    }

    // During the pending→uploaded bridge, lastGoodUri may hold a file:// URI.
    // Route it through localUri (not signedUrl) to match openAttachment's contract.
    const fallbackUri = lastGoodUri.current;
    const useLocalFallback =
      !isPending && !signedUrl && !!fallbackUri && fallbackUri.startsWith("file://");
    const result = await openAttachment({
      signedUrl: useLocalFallback ? null : (signedUrl ?? fallbackUri),
      localUri: useLocalFallback ? fallbackUri : attachment.localUri,
      isPending: isPending || useLocalFallback,
    });
    if (result.status === "unavailable") {
      showToast(result.reason, "warning");
    }
  }, [
    signedUrl,
    isPending,
    hasFailed,
    attachment.localUri,
    attachment.filePath,
    urlError,
    showToast,
    onRetry,
  ]);

  const handleDelete = useCallback(() => {
    onDelete(attachment);
  }, [attachment, onDelete]);

  if (isImage) {
    return (
      <View style={styles.imageItem}>
        {!isPending && loadingUrl && !displayUri ? (
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
        ) : urlError ? (
          <Pressable onPress={handlePress} style={styles.imagePlaceholder}>
            <Ionicons name="refresh-outline" size={24} color={colors.neutral[400]} />
            <Text style={styles.retryHint}>Tap to retry</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handlePress}
            style={styles.imagePlaceholder}
            accessibilityLabel={`Open ${attachment.fileName}`}
          >
            <Ionicons name="image-outline" size={24} color={colors.neutral[400]} />
            {imageError && <Text style={styles.retryHint}>Tap to open</Text>}
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
      disabled={!isPending && !signedUrl && !urlError && loadingUrl}
      accessibilityLabel={`Open ${attachment.fileName}`}
      accessibilityRole="link"
    >
      {urlError ? (
        <Ionicons name="refresh-outline" size={24} color={colors.neutral[400]} />
      ) : (
        <Ionicons name="document-outline" size={24} color={colors.primary[600]} />
      )}
      <View style={styles.fileInfo}>
        <View style={styles.fileNameRow}>
          {isPending && <PendingBadge />}
          <Text style={styles.fileFileName} numberOfLines={1}>
            {attachment.fileName}
          </Text>
        </View>
        <Text style={hasFailed ? styles.errorText : styles.fileMeta} numberOfLines={2}>
          {hasFailed
            ? (attachment.uploadError ?? "Upload failed — tap to retry")
            : urlError
              ? "Tap to retry"
              : formatFileSize(attachment.fileSize)}
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
    </Pressable>
  );
}

function PendingBadge() {
  return <Badge label="Pending" variant="warning" size="sm" />;
}

function FailedBadge() {
  return <Badge label="Failed" variant="error" size="sm" />;
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const { database, sync } = useDatabase();
  const { showToast } = useToast();
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
        renderItem={({ item }) => (
          <AttachmentItem
            attachment={item}
            onDelete={handleDelete}
            onRetry={handleRetry}
            showToast={showToast}
            styles={styles}
          />
        )}
      />
    </View>
  );
}

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
      marginTop: 2,
    },
    errorText: {
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      marginTop: 2,
    },
    fileNameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
  });
