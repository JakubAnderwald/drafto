"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type IconButtonVariant = "ghost" | "danger";
export type IconButtonSize = "sm" | "md" | "lg";

type AccessibleName = { "aria-label": string } | { "aria-labelledby": string };

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  AccessibleName & {
    variant?: IconButtonVariant;
    size?: IconButtonSize;
  };

const variantStyles: Record<IconButtonVariant, string> = {
  ghost: "text-neutral-600 hover:bg-neutral-100 focus-visible:ring-neutral-400",
  danger: "text-error hover:bg-red-50 focus-visible:ring-red-500",
};

const sizeStyles: Record<IconButtonSize, string> = {
  sm: "h-7 w-7 rounded-md",
  md: "h-9 w-9 rounded-lg",
  lg: "h-11 w-11 rounded-lg",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "ghost", size = "md", disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center transition-colors duration-[var(--transition-fast)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        variantStyles[variant],
        sizeStyles[size],
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
