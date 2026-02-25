import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";

async function ensureDefaultNotebook(userId: string) {
  const supabase = await createClient();

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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await ensureDefaultNotebook(user.id);

  return <AppShell>{children}</AppShell>;
}
