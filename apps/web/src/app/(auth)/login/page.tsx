"use client";

import { Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { enterApp } from "@/lib/auth/enter-app";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { AccountDeletedNotice } from "@/components/auth/account-deleted-notice";
import { AuthCallbackErrorNotice } from "@/components/auth/auth-callback-error-notice";
import { EmailConfirmedNotice } from "@/components/auth/email-confirmed-notice";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempted, setAttempted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAttempted(true);
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
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

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="mt-1"
          />
        </div>

        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1"
          />
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
            className="text-primary-600 hover:text-primary-700 transition-colors duration-[var(--transition-fast)] hover:underline"
          >
            Sign up
          </Link>
        </p>
        <p className="mt-2">
          <Link
            href="/forgot-password"
            className="text-primary-600 hover:text-primary-700 transition-colors duration-[var(--transition-fast)] hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
      </div>
    </>
  );
}
