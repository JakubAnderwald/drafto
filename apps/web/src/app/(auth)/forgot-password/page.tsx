"use client";

import { useRef, useState } from "react";
import { describeAuthError, validateEmailField } from "@drafto/shared";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/auth/field-error";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  function showEmailError(message: string) {
    setEmailError(message);
    emailRef.current?.focus();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // An empty or malformed address is refused here, under the field (PrimeTestLab 11035 M-02).
    const invalid = validateEmailField(email);
    if (invalid) {
      showEmailError(invalid);
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });

      if (resetError) {
        const copy = describeAuthError(resetError);
        if (copy.field === "email") showEmailError(copy.message);
        else setError(copy.message);
        return;
      }

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reset link");
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="text-center">
        <h1 className="text-fg mb-4 text-2xl font-bold">Check Your Email</h1>
        <p className="text-fg-muted mb-6">
          We&apos;ve sent a password reset link to{" "}
          <strong className="text-fg">{email.trim()}</strong>. Check your inbox and follow the link
          to reset your password.
        </p>
        <Link
          href="/login"
          className="text-primary-600 hover:text-primary-700 transition-colors duration-[var(--transition-fast)] hover:underline"
        >
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="text-fg mb-6 text-center text-2xl font-bold">Forgot Password</h1>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            ref={emailRef}
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(undefined);
            }}
            placeholder="you@example.com"
            className="mt-1"
            error={Boolean(emailError)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "forgot-password-email-error" : undefined}
          />
          <FieldError id="forgot-password-email-error" message={emailError} />
        </div>

        {error && (
          <div role="alert" className="text-error bg-error-bg rounded-md p-3 text-sm">
            {error}
          </div>
        )}

        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Sending..." : "Send reset link"}
        </Button>
      </form>

      <p className="text-fg-muted mt-4 text-center text-sm">
        <Link
          href="/login"
          className="text-primary-600 hover:text-primary-700 transition-colors duration-[var(--transition-fast)] hover:underline"
        >
          Back to login
        </Link>
      </p>
    </>
  );
}
