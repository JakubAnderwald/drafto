"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });

      if (resetError) {
        setError(resetError.message);
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
          We&apos;ve sent a password reset link to <strong className="text-fg">{email}</strong>.
          Check your inbox and follow the link to reset your password.
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
