"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { recordActivity, utcDay } from "@drafto/shared";
import { createClient } from "@/lib/supabase/client";

/**
 * sessionStorage key holding `<userId>:<UTC day>`: the last day this browser tab recorded
 * for that user (ADR 0080). Written only after the server accepted the day, so a failed
 * ping is retried on the next mount.
 */
export const ACTIVITY_DAY_STORAGE_KEY = "drafto:activity-day";

// The guards live at module level, not in the component: React StrictMode runs effects
// twice in development, and a remount must not send the same day again while the first
// call is still on its way.
let inFlightMarker: string | null = null;
// Fallback for a tab whose sessionStorage is unavailable (private mode, storage disabled):
// without it every remount in that page would send the day again.
let recordedMarker: string | null = null;
// A ping that fails once (offline, expired session) tends to fail on every retry, and each
// failure is the same signal, so only the first one in a page session reaches Sentry.
let failureReported = false;

function readStoredMarker(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVITY_DAY_STORAGE_KEY);
  } catch {
    // Storage is unavailable: behave as if nothing was recorded. At worst the server sees
    // a day it already has, which it ignores.
    return null;
  }
}

function storeMarker(marker: string): void {
  try {
    window.sessionStorage.setItem(ACTIVITY_DAY_STORAGE_KEY, marker);
  } catch {
    // Storage is unavailable: `recordedMarker` still prevents repeats in this page.
  }
}

function reportFailure(error: string): void {
  if (failureReported) return;
  failureReported = true;
  Sentry.captureMessage("Activity ping failed", {
    level: "warning",
    tags: { feature: "activity-ping", client: "web" },
    extra: { error },
  });
}

async function sendPing(marker: string, day: string): Promise<void> {
  inFlightMarker = marker;
  try {
    // recordActivity never throws; the try/catch covers creating the client.
    const outcome = await recordActivity(createClient(), [day], "web");
    if (outcome.ok) {
      recordedMarker = marker;
      storeMarker(marker);
    } else {
      reportFailure(outcome.error);
    }
  } catch (err) {
    reportFailure(err instanceof Error ? err.message : String(err));
  } finally {
    if (inFlightMarker === marker) inFlightMarker = null;
  }
}

/** Sends today's activity day for <userId> unless this tab already sent (or is sending) it. */
function pingActivity(userId: string): void {
  const day = utcDay();
  const marker = `${userId}:${day}`;
  if (marker === inFlightMarker || marker === recordedMarker) return;
  if (marker === readStoredMarker()) return;
  // Fire-and-forget: sendPing handles its own errors, and rendering never waits for it.
  void sendPing(marker, day);
}

/**
 * Records that the signed-in user opened Drafto today (UTC), from the web, at most once per
 * browser session per UTC day (ADR 0080). Only the day is sent: never a note, page or action.
 *
 * The ping runs in an effect, after render, and is never awaited. A failure leaves the day
 * unmarked, so the next mount tries again, and is reported to Sentry as a warning at most
 * once per page session.
 */
export function useActivityPing(userId: string): void {
  useEffect(() => {
    pingActivity(userId);

    // In-app navigation doesn't remount the app layout, so a tab left open across midnight
    // UTC would otherwise never record the new day. Check again whenever the user comes back
    // to the tab; on a day already recorded this is a no-op.
    const onReturn = () => {
      if (document.visibilityState === "visible") pingActivity(userId);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [userId]);
}
