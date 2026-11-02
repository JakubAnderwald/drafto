import { useSyncExternalStore } from "react";

/**
 * Whether the login screen should confirm that the user's own account was just deleted.
 *
 * Set by the auth provider once the server confirms a deletion, before the session clears, so
 * the login screen the route guard opens next shows it from its first render. It is state, not
 * a one-off event, for the same reason as `auth-callback-errors.ts`: the login screen can mount
 * more than once while the router settles. It stays until the next sign-in attempt starts or a
 * sign-in succeeds.
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
