import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface MetricsColumn {
  header: string;
  /** Numbers align right. */
  numeric?: boolean;
}

export interface MetricsRow {
  key: string;
  cells: ReactNode[];
}

export interface MetricsTableProps {
  /** Screen-reader caption. */
  label: string;
  columns: MetricsColumn[];
  rows: MetricsRow[];
  /** Shown instead of the table when there are no rows. */
  emptyText?: string;
}

/** A plain table: units in headers, numbers right-aligned, scrolling sideways inside its card. */
export function MetricsTable({ label, columns, rows, emptyText = "No data." }: MetricsTableProps) {
  if (rows.length === 0) return <p className="text-fg-muted text-sm">{emptyText}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-border border-b">
            {columns.map((col, i) => (
              <th
                // Headers can repeat (a client tag equal to a fixed header); position is the identity.
                key={i}
                scope="col"
                className={cn(
                  "text-fg-muted px-2 py-1.5 font-medium whitespace-nowrap",
                  col.numeric ? "text-right" : "text-left",
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-border border-b last:border-b-0">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={cn(
                    "text-fg px-2 py-1.5 whitespace-nowrap",
                    columns[i]?.numeric ? "text-right tabular-nums" : "text-left",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
