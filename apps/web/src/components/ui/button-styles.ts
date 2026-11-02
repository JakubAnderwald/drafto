import { cn } from "@/lib/cn";

/*
 * The Button look, kept free of "use client" so server components can style an
 * element that must not be a `<button>` (e.g. an `<a>` to a custom-scheme deep
 * link) without importing a client module.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "sm" | "md" | "lg";

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-primary-600 text-white hover:bg-primary-700 focus-visible:ring-primary-500",
  secondary: "bg-bg-muted text-fg hover:bg-bg-muted-hover focus-visible:ring-neutral-400",
  ghost: "bg-transparent text-fg-muted hover:bg-bg-muted focus-visible:ring-neutral-400",
  danger: "bg-error text-white hover:bg-error-hover focus-visible:ring-error",
  success: "bg-success text-white hover:bg-success-hover focus-visible:ring-success",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-sm rounded-md",
  md: "px-4 py-2 text-sm rounded-md",
  lg: "px-5 py-2.5 text-base rounded-md",
};

export interface ButtonClassNameOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  className?: string;
}

/** The Button look as a class string, for elements that must not be a `<button>`. */
export function buttonClassName({
  variant = "primary",
  size = "md",
  disabled = false,
  className,
}: ButtonClassNameOptions = {}): string {
  return cn(
    "inline-flex items-center justify-center font-medium transition-colors duration-[var(--transition-fast)] focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
    variantStyles[variant],
    sizeStyles[size],
    disabled && "pointer-events-none opacity-50",
    className,
  );
}
