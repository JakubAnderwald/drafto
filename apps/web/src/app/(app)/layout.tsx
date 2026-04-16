import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";

async function ensureDefaultNotebook(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
) {
  const { data: notebooks, error: selectError } = await supabase
    .from("notebooks")
    .select("id")
    .eq("user_id", userId)
    .limit(1);

  if (selectError) {
    throw selectError;
  }

  if (!notebooks || notebooks.length === 0) {
    const { error: insertError } = await supabase.from("notebooks").insert({
      user_id: userId,
      name: "Notes",
    });

    if (insertError) {
      throw insertError;
    }
  }
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Try the middleware-verified header first to skip the redundant getUser() call.
  // Fall back to getUser() for edge cases (e.g., first request after client-side login
  // where RSC navigation may not carry the middleware header).
  const headersList = await headers();
  let userId = headersList.get("x-verified-user-id");

  const supabase = await createClient();

  if (!userId) {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError && !("__isAuthError" in authError)) {
      throw authError;
    }

    if (!user) {
      redirect("/login");
    }

    userId = user.id;
  }

  await ensureDefaultNotebook(supabase, userId);

  // Prefetch notebooks + first notebook's notes on the server to eliminate
  // the client-side fetch waterfall (saves ~600ms of sequential API calls).
  const { data: notebooks } = await supabase
    .from("notebooks")
    .select("id, name, created_at, updated_at")
    .eq("user_id", userId)
    .order("name");

  const firstNotebookId = notebooks?.[0]?.id ?? null;

  let initialNotes: { id: string; title: string; created_at: string; updated_at: string }[] = [];
  if (firstNotebookId) {
    const { data: notes } = await supabase
      .from("notes")
      .select("id, title, created_at, updated_at")
      .eq("notebook_id", firstNotebookId)
      .eq("user_id", userId)
      .eq("is_trashed", false)
      .order("updated_at", { ascending: false });
    initialNotes = notes ?? [];
  }

  return (
    <AppShell
      initialNotebooks={notebooks ?? []}
      initialNotebookId={firstNotebookId}
      initialNotes={initialNotes}
    >
      {children}
    </AppShell>
  );
}
