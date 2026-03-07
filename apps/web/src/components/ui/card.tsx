"use client";

import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type CardShadow = "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  shadow?: CardShadow;
}

const shadowStyles: Record<CardShadow, string> = {
  sm: "shadow-sm",
  md: "shadow-md",
  lg: "shadow-lg",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { shadow = "sm", className, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "border-border bg-bg rounded-xl border transition-shadow duration-[var(--transition-normal)]",
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
    <div ref={ref} className={cn("border-border border-b px-6 py-4", className)} {...props}>
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
    <div ref={ref} className={cn("border-border border-t px-6 py-4", className)} {...props}>
      {children}
    </div>
  );
});
