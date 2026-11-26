"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/report-error";
import { ACCOUNT_INACTIVE_MESSAGE, ACCOUNT_INACTIVE_TITLE } from "@drafto/shared";

// Where the middleware sends a signed-in account whose `profiles.is_approved` is false: a
// signup never activated from before open signup, or an account an admin suspended (ADR 0094).
// The route keeps its old name so the middleware and the apps' navigators stay unchanged.
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
      // Still leave for /login: the user asked to go, and the middleware sends a live session back.
      reportError(error, "waiting-for-approval:sign-out");
    }
    router.push("/login");
  }

  return (
    <div className="text-center">
      <h1 className="text-fg mb-4 text-2xl font-bold">{ACCOUNT_INACTIVE_TITLE}</h1>
      {email && (
        <p className="text-fg mb-2 font-medium break-all" data-testid="inactive-account-email">
          {email}
        </p>
      )}
      <p className="text-fg-muted mb-6">{ACCOUNT_INACTIVE_MESSAGE}</p>
      <Button variant="secondary" onClick={handleLogout}>
        Log out
      </Button>
    </div>
  );
}
