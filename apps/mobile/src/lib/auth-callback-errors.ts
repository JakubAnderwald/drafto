import { useSyncExternalStore } from "react";

/**
 * The error from an auth callback that no screen started waiting for (see
 * `claimAuthCallbackDelivery`), held for the login screen.
 *
 * It is state, not a one-off event: after a cold start the login screen can
 * mount, unmount and mount again while the router settles, and an event taken
 * by the first instance would never reach the one left on screen. It stays
 * until a new sign-in attempt starts or one succeeds.
 */

let current: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAuthCallbackError(): string | null {
  return current;
}

export function reportAuthCallbackError(message: string): void {
  current = message;
  notify();
}

export function clearAuthCallbackError(): void {
  if (current === null) return;
  current = null;
  notify();
}

export function useAuthCallbackError(): string | null {
  return useSyncExternalStore(subscribe, getAuthCallbackError, getAuthCallbackError);
}
