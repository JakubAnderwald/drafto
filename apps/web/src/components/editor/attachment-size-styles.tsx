import { useMemo } from "react";
import { buildFileBlockSizeCss, type AttachmentSizeInfo } from "@drafto/shared";

interface AttachmentSizeStylesProps {
  attachments: readonly AttachmentSizeInfo[];
}

/**
 * Writes each file's size after its name in BlockNote's file block
 * (PrimeTestLab 11035 S-04). The rules only set `content`, matched on the
 * block's stored URL; the label's look is in globals.css. The block schema
 * and stored content are untouched.
 */
export function AttachmentSizeStyles({ attachments }: AttachmentSizeStylesProps) {
  const css = useMemo(() => buildFileBlockSizeCss(attachments), [attachments]);
  if (!css) return null;
  return <style data-testid="attachment-size-styles">{css}</style>;
}
