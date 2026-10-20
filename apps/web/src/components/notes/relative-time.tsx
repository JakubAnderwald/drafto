"use client";

import { useSyncExternalStore } from "react";
import { formatRelativeTime } from "@drafto/shared";

// Whether this render happens after hydration. Nothing changes once the page is
// hydrated, so the store never notifies its subscribers.
function subscribe(): () => void {
  return () => {};
}

function getClientSnapshot(): boolean {
  return true;
}

function getServerSnapshot(): boolean {
  return false;
}

interface RelativeTimeProps {
  /** An ISO-8601 timestamp, e.g. a row's `updated_at`. */
  value: string;
}

/**
 * A relative timestamp ("5m ago") that is safe to server-render.
 *
 * The text depends on the clock, and for older dates on the timezone and locale, so
 * the server's text and the browser's rarely match. `suppressHydrationWarning`
 * stops React from failing hydration over it, but React then leaves the server's
 * text in place, and a later render with an unchanged string doesn't touch the DOM
 * either. So the element is keyed on the hydration state: right after hydration it
 * remounts with the browser's own text. Elements first mounted in the browser render
 * the browser's text straight away and never remount.
 */
export function RelativeTime({ value }: RelativeTimeProps) {
  const hydrated = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);

  return (
    <time key={hydrated ? "client" : "server"} dateTime={value} suppressHydrationWarning>
      {formatRelativeTime(value)}
    </time>
  );
}
