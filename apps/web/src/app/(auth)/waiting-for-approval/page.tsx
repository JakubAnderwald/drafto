"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function WaitingForApprovalPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error("Failed to sign out:", error);
    }
    router.push("/login");
  }

  return (
    <div className="text-center">
      <h1 className="text-fg mb-4 text-2xl font-bold">Waiting for approval</h1>
      <p className="text-fg-muted mb-2">
        Thanks for signing up! Drafto is invite-only — an admin has been notified and will review
        your account shortly.
      </p>
      <p className="text-fg-muted mb-6">
        {email ? (
          <>
            We&rsquo;ll email <span className="text-fg font-medium">{email}</span> as soon as
            you&rsquo;re approved. Feel free to close this tab.
          </>
        ) : (
          <>We&rsquo;ll email you as soon as you&rsquo;re approved. Feel free to close this tab.</>
        )}
      </p>
      <Button variant="secondary" onClick={handleLogout}>
        Log out
      </Button>
    </div>
  );
}
