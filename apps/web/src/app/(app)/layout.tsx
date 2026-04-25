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
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const headersList = await headers();
  const headerUserId = headersList.get("x-verified-user-id");
  let userId = headerUserId && UUID_REGEX.test(headerUserId) ? headerUserId : null;

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

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();
  const isAdmin = profileRow?.is_admin ?? false;

  // Prefetch notebooks + first notebook's notes on the server to eliminate
  // the client-side fetch waterfall (saves ~600ms of sequential API calls).
  const { data: notebooks, error: notebooksError } = await supabase
    .from("notebooks")
    .select("id, name, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (notebooksError) {
    console.error("[layout] Failed to prefetch notebooks:", notebooksError.message);
  }

  const firstNotebookId = notebooks?.[0]?.id ?? null;

  let initialNotes: { id: string; title: string; created_at: string; updated_at: string }[] = [];
  if (firstNotebookId) {
    const { data: notes, error: notesError } = await supabase
      .from("notes")
      .select("id, title, created_at, updated_at")
      .eq("notebook_id", firstNotebookId)
      .eq("user_id", userId)
      .eq("is_trashed", false)
      .order("updated_at", { ascending: false });
    if (notesError) {
      console.error("[layout] Failed to prefetch notes:", notesError.message);
    }
    initialNotes = notes ?? [];
  }

  return (
    <AppShell
      initialNotebooks={notebooks ?? []}
      initialNotebookId={firstNotebookId}
      initialNotes={initialNotes}
      isAdmin={isAdmin}
    >
      {children}
    </AppShell>
  );
}
