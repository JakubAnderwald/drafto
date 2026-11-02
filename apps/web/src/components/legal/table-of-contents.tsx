import { useId } from "react";
import type { OutlineEntry } from "@/components/legal/document-outline";
import { Card } from "@/components/ui/card";

export interface TableOfContentsProps {
  entries: readonly OutlineEntry[];
}

/**
 * Numbered in-page links to each section of a long-form document. On wider screens the
 * entries run down the first column, then the second, so the numbers read in order.
 */
export function TableOfContents({ entries }: TableOfContentsProps) {
  const headingId = useId();
  const rows = Math.ceil(entries.length / 2);
  return (
    <Card>
      <nav aria-labelledby={headingId} className="p-6 sm:p-8">
        <h2
          id={headingId}
          className="text-fg-muted text-xs font-semibold tracking-widest uppercase"
        >
          On this page
        </h2>
        <ol
          className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-flow-col sm:grid-cols-2"
          style={{ gridTemplateRows: `repeat(${rows}, auto)` }}
        >
          {entries.map((entry, index) => (
            <li key={entry.id} className="flex gap-3">
              <span className="text-fg-muted w-5 shrink-0 text-right tabular-nums">
                {index + 1}.
              </span>{" "}
              <a href={`#${entry.id}`} className="text-fg underline-offset-4 hover:underline">
                {entry.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </Card>
  );
}
