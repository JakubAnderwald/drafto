"use client";

import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { required, className, children, ...props },
  ref,
) {
  return (
    <label ref={ref} className={cn("text-fg-muted text-sm font-medium", className)} {...props}>
      {children}
      {required && <span className="text-error ml-0.5">*</span>}
    </label>
  );
});
