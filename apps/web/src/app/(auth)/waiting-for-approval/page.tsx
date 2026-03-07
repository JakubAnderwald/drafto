"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function WaitingForApprovalPage() {
  const router = useRouter();

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
      <h1 className="text-fg mb-4 text-2xl font-bold">Waiting for Approval</h1>
      <p className="text-fg-muted mb-6">
        Your account is pending approval. You&apos;ll be able to access Drafto once an admin
        approves your account.
      </p>
      <Button variant="secondary" onClick={handleLogout}>
        Log out
      </Button>
    </div>
  );
}
