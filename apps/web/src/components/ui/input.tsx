"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize;
  error?: boolean;
}

const sizeStyles: Record<InputSize, string> = {
  sm: "px-2.5 py-1 text-sm rounded-md",
  md: "px-3 py-2 text-sm rounded-md",
  lg: "px-4 py-2.5 text-base rounded-md",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { inputSize = "md", error = false, className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "bg-bg text-fg border-outline-variant placeholder:text-fg-subtle w-full border transition-colors duration-[var(--transition-fast)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
        error ? "border-error bg-error-bg focus-visible:ring-error" : "focus-visible:ring-ring",
        sizeStyles[inputSize],
        className,
      )}
      {...props}
    />
  );
});
