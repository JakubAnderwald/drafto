import type { BlockNoteEditor } from "@blocknote/core";

/**
 * Takes back the block BlockNote made for an upload that was refused because
 * storage is full, so the editor's "Storage full" banner is the only message:
 * BlockNote's upload panel would otherwise add a generic "Upload failed" next to
 * it, and a dropped or pasted file would leave an empty file block in the note.
 * Changing the document closes BlockNote's file panel, and BlockNote stops
 * handling the upload once the block is gone.
 *
 * Only an unfilled placeholder is touched, never the user's content:
 * - A block that already has its file (Replace on an image already in the note
 *   hands over that image's block) is left as it is. BlockNote's Replace panel
 *   then shows its own "Upload failed" for a few seconds beside the banner;
 *   keeping the user's image matters more.
 * - BlockNote converts an empty block in place rather than inserting a new one,
 *   and the converted block keeps that block's nested children. Such a
 *   placeholder turns back into an empty paragraph, so its children stay where
 *   they were, instead of being removed with it.
 * - A block that is no longer an empty file block is left as it is. The upload
 *   is async, so by the time it is refused the user may have turned the block
 *   into another type (which has no `url` prop) or given it text.
 * - Anything else, the fresh placeholder of a paste, drop or the slash menu, is
 *   removed.
 */
export function discardRefusedUploadBlock(editor: BlockNoteEditor, blockId: string): void {
  const block = editor.getBlock(blockId);
  if (!block) return;

  // Only an unfilled file block: its `url` prop exists and is still empty, and it
  // has no inline content (file blocks have none).
  const props: Record<string, unknown> = block.props;
  if (props.url !== "") return;
  if (Array.isArray(block.content) && block.content.length > 0) return;

  if (block.children.length > 0) {
    editor.updateBlock(blockId, { type: "paragraph", content: [] });
    return;
  }
  editor.removeBlocks([blockId]);
}
