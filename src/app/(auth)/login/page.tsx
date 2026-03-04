"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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

    router.push("/");
  }

  return (
    <>
      <h1 className="text-fg mb-6 text-center text-2xl font-bold">Log In</h1>

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

      <div className="text-fg-muted mt-4 text-center text-sm">
        <p>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="text-primary-600 transition-colors duration-[var(--transition-fast)] hover:underline"
          >
            Sign up
          </Link>
        </p>
        <p className="mt-2">
          <Link
            href="/forgot-password"
            className="text-primary-600 transition-colors duration-[var(--transition-fast)] hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
      </div>
    </>
  );
}
