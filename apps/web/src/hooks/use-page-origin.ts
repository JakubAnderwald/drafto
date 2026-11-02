"use client";

import { useSyncExternalStore } from "react";
import { SITE_URL } from "@/lib/site";

// A page's origin doesn't change while it's open, so the store never notifies its subscribers.
function subscribe(): () => void {
  return () => {};
}

function getClientSnapshot(): string {
  return window.location.origin;
}

// On the server this hook has no access to the request, so it renders the canonical origin.
function getServerSnapshot(): string {
  return SITE_URL;
}

/**
 * The origin the page is served from: a Vercel preview's own URL, `http://localhost:3000`
 * locally, `https://drafto.eu` in production.
 *
 * Safe to server-render. The server renders `SITE_URL`, and React hydrates with that same
 * value, so the server HTML and the client's first render agree. React then re-renders with the
 * browser's origin. A component first mounted in the browser gets the browser's origin straight
 * away.
 */
export function usePageOrigin(): string {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
