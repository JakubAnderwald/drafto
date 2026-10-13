import type { User } from "@supabase/supabase-js";

/**
 * The Apple user IDs (`sub`) of the account's Sign in with Apple identities.
 * Empty for an account that was never linked to Apple.
 *
 * Supabase keeps the `sub` in `identity_data.sub`, and also uses it as the
 * identity's `id` (the provider ID), so both are collected.
 */
export function appleSubjectsOf(user: Pick<User, "identities">): string[] {
  const subjects = new Set<string>();
  for (const identity of user.identities ?? []) {
    if (identity.provider !== "apple") continue;
    const sub: unknown = identity.identity_data?.sub;
    if (typeof sub === "string" && sub.length > 0) subjects.add(sub);
    if (identity.id) subjects.add(identity.id);
  }
  return [...subjects];
}
