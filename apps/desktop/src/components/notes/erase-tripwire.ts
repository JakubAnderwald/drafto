// Shrinkage tripwire for note content saves. Refuses a save that would
// replace substantial existing content with the empty-BlockNote signature.
// The 2026-04-24 (PR #323) and 2026-04-27 incidents both produced this
// exact pattern — a ~50-byte write wiping 20–40 KB notes. The check is
// intentionally narrow: it only fires on the catastrophic-erase signature,
// never on legitimate user shrinkage. See ADR 0022 for the recovery
// infrastructure that backs this up.

const TRIPWIRE_PROTECTED_BYTES = 1000;

export function isCatastrophicEraseSave(
  oldContent: string | null | undefined,
  newContent: string,
): boolean {
  if (!oldContent || oldContent.length < TRIPWIRE_PROTECTED_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(newContent);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  if (parsed.length === 0) return true;
  if (parsed.length > 1) return false;
  const block = parsed[0] as { type?: string; content?: unknown; text?: string };
  if (block?.type !== "paragraph") return false;
  const isEmptyContent =
    !block.content || (Array.isArray(block.content) && block.content.length === 0);
  return isEmptyContent && !block.text;
}
