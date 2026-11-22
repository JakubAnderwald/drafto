import * as Sentry from "@sentry/nextjs";
import type { createAdminClient } from "@/lib/supabase/admin";

export interface AdminEmails {
  /** Each admin's email, once, in the order the profiles came back. */
  emails: string[];
  /**
   * True when the admins couldn't be listed: the profiles query failed, or there are admins
   * but not one of their emails could be read. An empty `emails` then means nothing.
   */
  failed: boolean;
}

/**
 * The email of every account with `profiles.is_admin = true`, looked up when called, so no
 * address lives in the repo or in env vars. An admin whose auth user can't be read is
 * reported to Sentry and left out.
 */
export async function listAdminEmails(
  admin: ReturnType<typeof createAdminClient>,
): Promise<AdminEmails> {
  const { data: adminProfiles, error } = await admin
    .from("profiles")
    .select("id")
    .eq("is_admin", true);

  if (error) {
    Sentry.captureException(error, { extra: { where: "listAdminEmails:profiles" } });
    return { emails: [], failed: true };
  }

  const emails = new Set<string>();
  let lookupsFailed = 0;
  const ids = (adminProfiles ?? []).map((p) => p.id);
  for (const id of ids) {
    const { data: adminUser, error: userError } = await admin.auth.admin.getUserById(id);
    if (userError) {
      Sentry.captureException(userError, { extra: { where: "listAdminEmails:authUser", id } });
      lookupsFailed += 1;
      continue;
    }
    if (adminUser.user?.email) emails.add(adminUser.user.email);
  }
  return { emails: [...emails], failed: emails.size === 0 && lookupsFailed > 0 };
}
