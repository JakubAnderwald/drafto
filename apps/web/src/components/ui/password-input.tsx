"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";
import { cn } from "@/lib/cn";
import { IconButton } from "@/components/ui/icon-button";
import { Input, type InputProps } from "@/components/ui/input";

export interface PasswordInputProps extends Omit<InputProps, "type"> {
  /** Classes for the wrapper that holds the input and the toggle (e.g. spacing like `mt-1`). */
  wrapperClassName?: string;
}

/**
 * A password field with a show/hide toggle. The input stays `type="password"` until the user
 * asks to see it, and stays as the user left it when its form submits. `id`, `name` and
 * `autoComplete` stay on the same element in both states, so password managers keep matching it.
 *
 * Edge draws its own reveal button inside password fields (`::-ms-reveal`), which would sit
 * next to this toggle, so the input hides it.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ wrapperClassName, className, disabled, id, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle<HTMLInputElement | null, HTMLInputElement | null>(
      ref,
      () => inputRef.current,
      [],
    );

    return (
      <div className={cn("relative", wrapperClassName)}>
        <Input
          {...props}
          ref={inputRef}
          id={id}
          disabled={disabled}
          type={visible ? "text" : "password"}
          className={cn("pr-10 [&::-ms-clear]:hidden [&::-ms-reveal]:hidden", className)}
        />
        <IconButton
          size="sm"
          variant="ghost"
          className="absolute top-1/2 right-1 -translate-y-1/2"
          aria-label={visible ? PASSWORD_VISIBILITY_LABELS.hide : PASSWORD_VISIBILITY_LABELS.show}
          aria-controls={id}
          data-testid={id ? `${id}-toggle` : undefined}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </IconButton>
      </div>
    );
  },
);

function EyeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon="eye"
    >
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon="eye-off"
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
