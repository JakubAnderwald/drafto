import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

async function ensureDefaultNotebook(userId: string) {
  const supabase = await createClient();

  const { data: notebooks } = await supabase
    .from("notebooks")
    .select("id")
    .eq("user_id", userId)
    .limit(1);

  if (!notebooks || notebooks.length === 0) {
    await supabase.from("notebooks").insert({
      user_id: userId,
      name: "Notes",
    });
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

  return <>{children}</>;
}
