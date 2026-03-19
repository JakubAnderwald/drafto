"use client";

import {
  forwardRef,
  useEffect,
  useRef,
  type HTMLAttributes,
  type ButtonHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

/* -------------------------------------------------------------------------- */
/*  DropdownMenu (container)                                                   */
/* -------------------------------------------------------------------------- */

export interface DropdownMenuProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  /** Alignment relative to the trigger. Default: "right" */
  align?: "left" | "right";
}

export const DropdownMenu = forwardRef<HTMLDivElement, DropdownMenuProps>(function DropdownMenu(
  { open, onClose, align = "right", className, children, ...props },
  ref,
) {
  const internalRef = useRef<HTMLDivElement>(null);
  const menuRef = (ref as React.RefObject<HTMLDivElement | null>) ?? internalRef;

  // Close on outside click
  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose, menuRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      className={cn(
        "bg-glass-bg absolute z-10 min-w-[12rem] animate-[dropdown-in_var(--transition-fast)_ease-out] rounded-lg py-1 shadow-md backdrop-blur-[16px] motion-reduce:animate-none",
        align === "right" ? "right-0" : "left-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/*  DropdownMenuItem                                                           */
/* -------------------------------------------------------------------------- */

export type DropdownMenuItemVariant = "default" | "danger";

export interface DropdownMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: DropdownMenuItemVariant;
}

const itemVariantStyles: Record<DropdownMenuItemVariant, string> = {
  default: "text-fg hover:bg-bg-muted",
  danger: "text-error hover:bg-error-bg",
};

export const DropdownMenuItem = forwardRef<HTMLButtonElement, DropdownMenuItemProps>(
  function DropdownMenuItem({ variant = "default", className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        className={cn(
          "w-full truncate rounded-md px-3 py-1.5 text-left text-sm transition-colors duration-[var(--transition-fast)]",
          itemVariantStyles[variant],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);

/* -------------------------------------------------------------------------- */
/*  DropdownMenuLabel                                                          */
/* -------------------------------------------------------------------------- */

export type DropdownMenuLabelProps = HTMLAttributes<HTMLParagraphElement>;

export const DropdownMenuLabel = forwardRef<HTMLParagraphElement, DropdownMenuLabelProps>(
  function DropdownMenuLabel({ className, children, ...props }, ref) {
    return (
      <p
        ref={ref}
        className={cn("text-fg-muted px-3 py-1 text-xs font-medium", className)}
        {...props}
      >
        {children}
      </p>
    );
  },
);

/* -------------------------------------------------------------------------- */
/*  DropdownMenuSeparator                                                      */
/* -------------------------------------------------------------------------- */

export type DropdownMenuSeparatorProps = HTMLAttributes<HTMLHRElement>;

export const DropdownMenuSeparator = forwardRef<HTMLHRElement, DropdownMenuSeparatorProps>(
  function DropdownMenuSeparator({ className, ...props }, ref) {
    return (
      <hr
        ref={ref}
        className={cn("border-outline-variant my-1", className)}
        role="separator"
        {...props}
      />
    );
  },
);
