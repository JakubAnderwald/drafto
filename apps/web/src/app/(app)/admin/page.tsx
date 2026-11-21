import * as Sentry from "@sentry/nextjs";
import { storageUsageFromRow } from "@drafto/shared";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/require-admin";
import { AdminUserList, type PendingUser } from "@/app/(app)/admin/admin-user-list";
import { AdminStorageList, type UserStorage } from "@/app/(app)/admin/admin-storage-list";
import { AdminFlashMessage } from "@/app/(app)/admin/admin-flash-message";
import { AdminCloseButton } from "@/app/(app)/admin/admin-close-button";

interface AdminPageProps {
  searchParams: Promise<{ approved?: string; error?: string }>;
}

const EMAIL_UNAVAILABLE = "(email unavailable)";

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const { supabase } = await requireAdmin();

  const [pendingResult, storageResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, display_name, created_at")
      .eq("is_approved", false)
      .order("created_at", { ascending: true }),
    // The admin's own session: the RPC refuses anyone who isn't an admin.
    supabase.rpc("admin_storage_usage"),
  ]);

  const { data: pendingProfiles, error: pendingUsersError } = pendingResult;
  if (pendingUsersError) throw pendingUsersError;

  // A storage failure must not take the approval list down with it. It still reaches
  // Sentry, and the storage section says it couldn't load.
  const { data: storageRows, error: storageError } = storageResult;
  if (storageError) {
    Sentry.captureException(storageError, { extra: { where: "admin-page:admin_storage_usage" } });
  }

  // One auth lookup per user, shared by both lists.
  const admin = createAdminClient();
  const emailLookups = new Map<string, Promise<string>>();
  function emailFor(userId: string): Promise<string> {
    let lookup = emailLookups.get(userId);
    if (!lookup) {
      lookup = admin.auth.admin
        .getUserById(userId)
        .then(({ data: authUser }) => authUser.user?.email ?? EMAIL_UNAVAILABLE);
      emailLookups.set(userId, lookup);
    }
    return lookup;
  }

  const pendingUsers: PendingUser[] = await Promise.all(
    (pendingProfiles ?? []).map(async (p) => ({
      id: p.id,
      display_name: p.display_name,
      created_at: p.created_at,
      email: await emailFor(p.id),
    })),
  );

  const storageUsers: UserStorage[] = storageError
    ? []
    : await Promise.all(
        (storageRows ?? []).flatMap((row) => {
          const usage = storageUsageFromRow(row);
          if (!usage) return [];
          return [
            emailFor(row.user_id).then((email) => ({
              id: row.user_id,
              email,
              usedBytes: usage.usedBytes,
              quotaBytes: usage.quotaBytes,
            })),
          ];
        }),
      );

  const params = await searchParams;

  return (
    // The app shell is a fixed-height row that clips overflow, so the panel scrolls itself.
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-8" data-testid="admin-panel">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-fg text-2xl font-bold">Admin — User Approval</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/admin/stats"
            className="text-primary-600 hover:text-primary-700 text-sm font-medium underline-offset-4 hover:underline"
          >
            Product metrics
          </Link>
          <AdminCloseButton />
        </div>
      </div>
      <AdminFlashMessage approved={params.approved} error={params.error} />
      <AdminUserList initialUsers={pendingUsers} />
      {storageError ? (
        <p className="text-error-text mt-10 text-sm" role="alert">
          Storage usage could not be loaded.
        </p>
      ) : (
        <AdminStorageList users={storageUsers} />
      )}
    </div>
  );
}
