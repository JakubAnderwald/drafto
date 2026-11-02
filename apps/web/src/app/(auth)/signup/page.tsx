"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SIGNUP_CONFIRMATION_SENT } from "@drafto/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OAuthButtons } from "@/components/auth/oauth-buttons";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          // Same browser: the callback exchanges the PKCE code and signs the user in. Another
          // browser has no verifier, so the callback sends them to login with an error notice
          // (the address is confirmed either way).
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      // With email confirmation on there is no session yet, and the middleware would bounce
      // /waiting-for-approval back to login. Say what happens next instead.
      if (!data.session) {
        setSentTo(email);
        return;
      }

      router.push("/waiting-for-approval");
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
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Min. 6 characters"
            className="mt-1"
          />
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
