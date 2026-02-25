"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

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
    <div className="rounded-lg bg-white p-8 text-center shadow">
      <h1 className="mb-4 text-2xl font-bold">Waiting for Approval</h1>
      <p className="mb-6 text-gray-600">
        Your account is pending approval. You&apos;ll be able to access Drafto once an admin
        approves your account.
      </p>
      <button
        type="button"
        onClick={handleLogout}
        className="rounded-md bg-gray-200 px-4 py-2 text-gray-700 hover:bg-gray-300 focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:outline-none"
      >
        Log out
      </button>
    </div>
  );
}
