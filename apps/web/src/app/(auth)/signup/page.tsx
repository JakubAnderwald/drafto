"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  MIN_PASSWORD_LENGTH,
  SIGNUP_CONFIRMATION_SENT,
  describeAuthError,
  hasFieldErrors,
  validateCredentials,
  type AuthFieldErrors,
} from "@drafto/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { FieldError } from "@/components/auth/field-error";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AuthFieldErrors>({});
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function showFieldErrors(errors: AuthFieldErrors) {
    setFieldErrors(errors);
    if (errors.email) emailRef.current?.focus();
    else if (errors.password) passwordRef.current?.focus();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // The form is `noValidate`, so this check runs instead of the browser's own: it reports both
    // fields at once, in Drafto's words, and a malformed address never reaches Supabase
    // (PrimeTestLab 11035 M-02).
    const validation = validateCredentials({ email, password }, "signup");
    showFieldErrors(validation);
    if (hasFieldErrors(validation)) return;

    const trimmedEmail = email.trim();
    setLoading(true);

    try {
      const supabase = createClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmedEmail,
        password,
        options: {
          // Same browser: the callback exchanges the PKCE code and signs the user in. Another
          // browser has no verifier, so the callback sends them to login with an error notice
          // (the address is confirmed either way).
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (signUpError) {
        const copy = describeAuthError(signUpError);
        if (copy.field) showFieldErrors({ [copy.field]: copy.message });
        else setError(copy.message);
        return;
      }

      // With email confirmation on there is no session yet, so say what happens next instead.
      if (!data.session) {
        setSentTo(trimmedEmail);
        return;
      }

      // A new account is active from the start (ADR 0094), so it goes straight to the app.
      router.push("/");
    } finally {
      setLoading(false);
    }
  }

  if (sentTo) {
    return (
      <div className="text-center" data-testid="signup-check-email">
        <h1 className="text-fg mb-4 text-2xl font-bold">Check Your Email</h1>
        <p className="text-fg mb-2 font-semibold break-all">{sentTo}</p>
        <p className="text-fg-muted mb-6">{SIGNUP_CONFIRMATION_SENT}</p>
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
      <h1 className="text-fg mb-6 text-center text-2xl font-bold">Create Account</h1>

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
            aria-describedby={fieldErrors.email ? "signup-email-error" : undefined}
          />
          <FieldError id="signup-email-error" message={fieldErrors.email} />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <PasswordInput
            ref={passwordRef}
            id="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setFieldErrors((current) => ({ ...current, password: undefined }));
            }}
            placeholder="Min. 6 characters"
            wrapperClassName="mt-1"
            error={Boolean(fieldErrors.password)}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? "signup-password-error" : undefined}
          />
          <FieldError id="signup-password-error" message={fieldErrors.password} />
        </div>

        {error && (
          <div role="alert" className="text-error bg-error-bg rounded-md p-3 text-sm">
            {error}
          </div>
        )}

        <Button type="submit" loading={loading} className="w-full">
          {loading ? "Creating account..." : "Sign up"}
        </Button>
      </form>

      <OAuthButtons />

      <p className="text-fg-muted mt-4 text-center text-sm">
        Already have an account?{" "}
        <Link
          href="/login"
          className="text-primary-600 hover:text-primary-700 transition-colors duration-[var(--transition-fast)] hover:underline"
        >
          Log in
        </Link>
      </p>
    </>
  );
}
