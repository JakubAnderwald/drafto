import * as Sentry from "@sentry/nextjs";
import { storageUsageFromRow, type StorageUsage } from "@drafto/shared";
import { createAdminClient } from "@/lib/supabase/admin";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listUserEmails } from "@/lib/auth/list-user-emails";
import { AdminUserList, type AdminAccount } from "@/app/(app)/admin/admin-user-list";
import { AdminStorageList, type UserStorage } from "@/app/(app)/admin/admin-storage-list";
import { AdminCloseButton } from "@/app/(app)/admin/admin-close-button";

const EMAIL_UNAVAILABLE = "(email unavailable)";

export default async function AdminPage() {
  const { supabase } = await requireAdmin();

  const [profilesResult, storageResult, contentResult] = await Promise.all([
    // Every account (ADR 0094): the admin's own session, through the admins-read-all policy.
    supabase
      .from("profiles")
      .select("id, display_name, created_at, is_approved, is_admin")
      .order("created_at", { ascending: false }),
    // The admin's own session: the RPC refuses anyone who isn't an admin.
    supabase.rpc("admin_storage_usage"),
    supabase.rpc("admin_content_usage"),
  ]);

  const { data: profiles, error: profilesError } = profilesResult;
  if (profilesError) throw profilesError;

  // A storage failure must not take the account list down with it. It still reaches
  // Sentry, and the storage section says it couldn't load.
  const { data: storageRows, error: storageError } = storageResult;
  if (storageError) {
    Sentry.captureException(storageError, { extra: { where: "admin-page:admin_storage_usage" } });
  }

  // Note content usage (ADR 0090) is optional the same way: without it the table still
  // shows storage, and each row's notes cells say it's unavailable.
  const { data: contentRows, error: contentError } = contentResult;
  if (contentError) {
    Sentry.captureException(contentError, { extra: { where: "admin-page:admin_content_usage" } });
  }
  const contentByUser = new Map<string, StorageUsage>();
  for (const row of contentError ? [] : (contentRows ?? [])) {
    const usage = storageUsageFromRow(row);
    if (usage) contentByUser.set(row.user_id, usage);
  }

  // One paged auth listing, shared by both lists.
  const emails = await listUserEmails(createAdminClient());
  const emailFor = (userId: string): string => emails.get(userId) ?? EMAIL_UNAVAILABLE;

  const accounts: AdminAccount[] = (profiles ?? []).map((p) => ({
    id: p.id,
    display_name: p.display_name,
    created_at: p.created_at,
    is_active: p.is_approved,
    is_admin: p.is_admin,
    email: emailFor(p.id),
  }));

  const storageUsers: UserStorage[] = storageError
    ? []
    : (storageRows ?? []).flatMap((row) => {
        const usage = storageUsageFromRow(row);
        if (!usage) return [];
        return [
          {
            id: row.user_id,
            email: emailFor(row.user_id),
            usedBytes: usage.usedBytes,
            quotaBytes: usage.quotaBytes,
            content: contentByUser.get(row.user_id) ?? null,
          },
        ];
      });

  return (
    // The app shell is a fixed-height row that clips overflow, so the panel scrolls itself.
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-8" data-testid="admin-panel">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-fg text-2xl font-bold">Admin — Accounts</h1>
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
      <AdminUserList initialUsers={accounts} />
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
