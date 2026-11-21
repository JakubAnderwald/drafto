import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";

export type MetricsSectionTone = "default" | "warning";

export interface MetricsSectionProps {
  /** Stable id: the heading's id is `metrics-<id>`, the test id `metrics-section-<id>`. */
  id: string;
  title: string;
  /** One line: the question the section answers. */
  caption: string;
  tone?: MetricsSectionTone;
  children: ReactNode;
}

/** One card on `/admin/stats`: a heading, a "what this answers" caption, then the content. */
export function MetricsSection({
  id,
  title,
  caption,
  tone = "default",
  children,
}: MetricsSectionProps) {
  const headingId = `metrics-${id}`;
  return (
    <section aria-labelledby={headingId} data-testid={`metrics-section-${id}`}>
      <Card className={cn(tone === "warning" && "bg-warning-bg")}>
        <CardHeader className="pb-2">
          <h2 id={headingId} className="text-fg text-lg font-semibold">
            {title}
          </h2>
          <p className="text-fg-muted mt-1 text-sm">{caption}</p>
        </CardHeader>
        <CardBody className="space-y-4 pt-2">{children}</CardBody>
      </Card>
    </section>
  );
}
