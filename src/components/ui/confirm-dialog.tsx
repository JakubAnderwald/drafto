"use client";

import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

export interface ConfirmDialogProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "warning";
  error?: string | null;
  loading?: boolean;
}

export const ConfirmDialog = forwardRef<HTMLDivElement, ConfirmDialogProps>(function ConfirmDialog(
  {
    title,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    onConfirm,
    onCancel,
    variant = "danger",
    error,
    loading = false,
    className,
    children,
    ...props
  },
  ref,
) {
  const confirmVariant = variant === "danger" ? "danger" : "primary";

  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-label={title}
      className={cn("border-border bg-bg-subtle border-t p-3", className)}
      {...props}
    >
      <p className="text-fg mb-2 text-xs font-medium">{title}</p>
      {children && <div className="text-fg-muted mb-2 text-xs">{children}</div>}
      {error && (
        <p className="text-error mb-2 text-xs" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
});
