import * as Sentry from "@sentry/nextjs";
import type { createAdminClient } from "@/lib/supabase/admin";

/** GoTrue's largest page; one request covers today's whole user base. */
const PAGE_SIZE = 1000;

/**
 * Every auth user's email, by user id, for the admin page. Since open signup (ADR 0094)
 * /admin lists every account, so it pages through `auth.admin.listUsers` instead of one
 * `getUserById` per account. A failed page is reported to Sentry and ends the listing: the
 * page still renders, and the accounts it didn't reach show without an email.
 */
export async function listUserEmails(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) {
      Sentry.captureException(error, { extra: { where: "listUserEmails", page } });
      return emails;
    }
    for (const user of data.users) {
      if (user.email) emails.set(user.id, user.email);
    }
    if (data.users.length < PAGE_SIZE) return emails;
  }
}
