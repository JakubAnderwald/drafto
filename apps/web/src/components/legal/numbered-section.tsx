import type { ReactNode } from "react";
import type { NumberedOutlineEntry } from "@/components/legal/document-outline";

export interface NumberedSectionProps extends NumberedOutlineEntry {
  children: ReactNode;
}

/** A numbered top-level section of a long-form document, styled by `.doc-prose`. */
export function NumberedSection({ id, number, title, children }: NumberedSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId}>
      <h2 id={headingId}>
        <span className="text-fg-muted font-normal tabular-nums">{number}.</span> {title}
      </h2>
      {children}
    </section>
  );
}
