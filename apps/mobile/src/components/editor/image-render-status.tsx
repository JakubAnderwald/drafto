import { StyleSheet, View } from "react-native";
import { imageRenderStatusLabel } from "@drafto/shared";
import type { ImageRenderState } from "@drafto/shared";

import { areE2EProbesEnabled } from "@/lib/e2e-probes";

interface ImageRenderStatusProps {
  images: readonly ImageRenderState[];
}

/**
 * Invisible, untouchable views that say whether each image in the editor
 * rendered (ADR-0086). The WebView's own image nodes don't reliably reach the
 * accessibility tree, so the E2E checks read these: one per image, labelled
 * "Image shown: <name>" or "Image not loaded: <name>". A shown image's view is
 * as tall as the image on screen; a missing one is a sliver. Screen readers
 * would read them too, so they render only in E2E builds (`areE2EProbesEnabled`).
 * Mirrors apps/desktop/src/components/editor/image-render-status.tsx.
 */
export function ImageRenderStatus({ images }: ImageRenderStatusProps) {
  if (images.length === 0 || !areE2EProbesEnabled()) return null;
  return (
    <View testID="editor-image-status" pointerEvents="none" style={styles.container}>
      {images.map((image, index) => (
        <View
          // Images come in document order; a name can repeat, so add the index.
          key={`${index}:${image.name}`}
          testID={image.rendered ? "editor-image-rendered" : "editor-image-missing"}
          accessible
          accessibilityLabel={imageRenderStatusLabel(image)}
          style={[styles.marker, { height: image.rendered ? Math.max(1, image.height) : 1 }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    width: 2,
  },
  marker: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 2,
    maxHeight: "100%",
  },
});
