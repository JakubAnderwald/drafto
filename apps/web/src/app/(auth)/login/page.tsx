"use client";

import { Suspense, useRef, useState } from "react";
import {
  describeAuthError,
  hasFieldErrors,
  validateCredentials,
  type AuthFieldErrors,
} from "@drafto/shared";
import { createClient } from "@/lib/supabase/client";
import { enterApp } from "@/lib/auth/enter-app";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { AccountDeletedNotice } from "@/components/auth/account-deleted-notice";
import { AuthCallbackErrorNotice } from "@/components/auth/auth-callback-error-notice";
import { EmailConfirmedNotice } from "@/components/auth/email-confirmed-notice";
import { FieldError } from "@/components/auth/field-error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [loading, setLoading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  function showFieldErrors(errors: AuthFieldErrors) {
    setFieldErrors(errors);
    if (errors.email) emailRef.current?.focus();
    else if (errors.password) passwordRef.current?.focus();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAttempted(true);

    // The form is `noValidate`: this check reports both fields at once, in Drafto's words, and a
    // malformed address never reaches Supabase (PrimeTestLab 11035 M-02).
    const validation = validateCredentials({ email, password }, "login");
    showFieldErrors(validation);
    if (hasFieldErrors(validation)) return;

    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      const copy = describeAuthError(signInError);
      if (copy.field) showFieldErrors({ [copy.field]: copy.message });
      else setError(copy.message);
      setLoading(false);
      return;
    }

    enterApp();
  }

  return (
    <>
      <h1 className="text-fg mb-6 text-center text-2xl font-bold">Log In</h1>

      <Suspense fallback={null}>
        <AccountDeletedNotice />
        <EmailConfirmedNotice />
        <AuthCallbackErrorNotice hidden={attempted} />
      </Suspense>

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
              setFieldErrors((current) => ({ ...current, email: undefined }));
            }}
            placeholder="you@example.com"
            className="mt-1"
            error={Boolean(fieldErrors.email)}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? "login-email-error" : undefined}
          />
          <FieldError id="login-email-error" message={fieldErrors.email} />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            ref={passwordRef}
            id="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((current) => ({ ...current, password: undefined }));
            }}
            wrapperClassName="mt-1"
            error={Boolean(fieldErrors.password)}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? "login-password-error" : undefined}
          />
          <FieldError id="login-password-error" message={fieldErrors.password} />
        </div>

        {error && (
          <div role="alert" className="text-error bg-error-bg rounded-md p-3 text-sm">
            {error}
          </div>
        )}

        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Logging in..." : "Log in"}
        </Button>
      </form>

      <OAuthButtons />

      <div className="text-fg-muted mt-4 text-center text-sm">
        <p>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="ui-link transition-colors duration-[var(--transition-fast)] hover:underline"
          >
            Sign up
          </Link>
        </p>
        <p className="mt-2">
          <Link
            href="/forgot-password"
            className="ui-link transition-colors duration-[var(--transition-fast)] hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
      </div>
    </>
  );
}
