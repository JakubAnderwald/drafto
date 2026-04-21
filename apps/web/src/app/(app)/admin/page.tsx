import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { AdminUserList, type PendingUser } from "@/app/(app)/admin/admin-user-list";
import { AdminFlashMessage } from "@/app/(app)/admin/admin-flash-message";

interface AdminPageProps {
  searchParams: Promise<{ approved?: string; error?: string }>;
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const supabase = await createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) throw userError;
  if (!user) redirect("/login");

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single();

  if (profileError) throw profileError;
  if (!profile?.is_admin) redirect("/");

  const { data: pendingProfiles, error: pendingUsersError } = await supabase
    .from("profiles")
    .select("id, display_name, created_at")
    .eq("is_approved", false)
    .order("created_at", { ascending: true });

  if (pendingUsersError) throw pendingUsersError;

  const admin = createAdminClient();
  const pendingUsers: PendingUser[] = await Promise.all(
    (pendingProfiles ?? []).map(async (p) => {
      const { data: authUser } = await admin.auth.admin.getUserById(p.id);
      return {
        id: p.id,
        display_name: p.display_name,
        created_at: p.created_at,
        email: authUser.user?.email ?? "(email unavailable)",
      };
    }),
  );

  const params = await searchParams;

  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-fg text-2xl font-bold">Admin — User Approval</h1>
        <span className="text-fg-muted text-sm">{pendingUsers.length} pending</span>
      </div>
      <AdminFlashMessage approved={params.approved} error={params.error} />
      <AdminUserList initialUsers={pendingUsers} />
    </div>
  );
}
