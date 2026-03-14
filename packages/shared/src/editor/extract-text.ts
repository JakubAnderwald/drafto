/**
 * Recursively extract all `.text` string values from BlockNote/TipTap JSON content.
 * TypeScript equivalent of the `extract_text_from_jsonb` PostgreSQL function.
 */
export function extractTextFromContent(content: unknown): string {
  const texts: string[] = [];
  collectText(content, texts);
  return texts.join(" ");
}

function collectText(node: unknown, texts: string[]): void {
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectText(item, texts);
    }
    return;
  }

  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) {
      texts.push(record.text);
    }
    for (const value of Object.values(record)) {
      if (typeof value === "object" && value !== null) {
        collectText(value, texts);
      }
    }
  }
}
