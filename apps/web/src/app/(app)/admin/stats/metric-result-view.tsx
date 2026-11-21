import type { ReactNode } from "react";
import type { MetricResult } from "@/lib/metrics/types";

export interface MetricResultViewProps<T> {
  result: MetricResult<T>;
  /** Shown when the function doesn't exist on this database. */
  unavailableText?: string;
  children: (data: T) => ReactNode;
}

export const DEFAULT_UNAVAILABLE_TEXT = "Not available on this database yet.";

/** Renders a metric's data, or the state it is in when it couldn't be read. */
export function MetricResultView<T>({
  result,
  unavailableText = DEFAULT_UNAVAILABLE_TEXT,
  children,
}: MetricResultViewProps<T>) {
  if (result.status === "unavailable") {
    return <p className="text-fg-muted text-sm">{unavailableText}</p>;
  }
  if (result.status === "error") {
    return (
      <p className="text-error-text text-sm" role="alert">
        Couldn&apos;t load this metric: {result.message}
      </p>
    );
  }
  return <>{children(result.data)}</>;
}
