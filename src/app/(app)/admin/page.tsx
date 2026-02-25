import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { AdminUserList } from "@/app/(app)/admin/admin-user-list";

export default async function AdminPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    throw userError;
  }

  if (!user) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (profileError) {
    throw profileError;
  }

  if (!profile?.is_admin) {
    redirect("/");
  }

  const { data: pendingUsers, error: pendingUsersError } = await supabase
    .from("profiles")
    .select("id, display_name, created_at")
    .eq("is_approved", false)
    .order("created_at", { ascending: true });

  if (pendingUsersError) {
    throw pendingUsersError;
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-bold">Admin — User Approval</h1>
      <AdminUserList initialUsers={pendingUsers ?? []} />
    </div>
  );
}
