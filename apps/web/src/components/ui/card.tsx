"use client";

import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type CardShadow = "sm" | "md" | "lg";
/** The card's background: the default surface, or tinted to flag something that needs attention. */
export type CardTone = "default" | "warning";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  shadow?: CardShadow;
  tone?: CardTone;
}

const toneStyles: Record<CardTone, string> = {
  default: "bg-bg-subtle",
  warning: "bg-warning-bg",
};

const shadowStyles: Record<CardShadow, string> = {
  sm: "shadow-sm",
  md: "shadow-md",
  lg: "shadow-lg",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { shadow = "sm", tone = "default", className, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg transition-shadow duration-[var(--transition-normal)]",
        toneStyles[tone],
        shadowStyles[shadow],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
});

export type CardHeaderProps = HTMLAttributes<HTMLDivElement>;

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
  { className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn("px-6 py-4", className)} {...props}>
      {children}
    </div>
  );
});

export type CardBodyProps = HTMLAttributes<HTMLDivElement>;

export const CardBody = forwardRef<HTMLDivElement, CardBodyProps>(function CardBody(
  { className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn("px-6 py-4", className)} {...props}>
      {children}
    </div>
  );
});

export type CardFooterProps = HTMLAttributes<HTMLDivElement>;

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(function CardFooter(
  { className, children, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn("px-6 py-4", className)} {...props}>
      {children}
    </div>
  );
});
