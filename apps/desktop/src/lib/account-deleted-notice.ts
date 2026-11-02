import { useSyncExternalStore } from "react";

/**
 * Whether the login screen should confirm that the user's own account was just deleted.
 *
 * Set by the auth provider once the server confirms a deletion, before the session clears, so
 * the login screen the navigator shows next has it from its first render. It is state rather
 * than a prop or an event because it outlives the screens: the sidebar that ran the deletion
 * unmounts, and the login screen mounts afterwards. It stays until the next sign-in attempt
 * starts or a sign-in succeeds. Mirrors `apps/mobile/src/lib/account-deleted-notice.ts`.
 */

let shown = false;
const listeners = new Set<() => void>();

function setShown(next: boolean): void {
  if (shown === next) return;
  shown = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isAccountDeletedNoticeShown(): boolean {
  return shown;
}

export function reportAccountDeleted(): void {
  setShown(true);
}

export function clearAccountDeletedNotice(): void {
  setShown(false);
}

export function useAccountDeletedNotice(): boolean {
  return useSyncExternalStore(subscribe, isAccountDeletedNoticeShown, isAccountDeletedNoticeShown);
}
