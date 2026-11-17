"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { recordActivity, utcDay } from "@drafto/shared";
import { createClient } from "@/lib/supabase/client";

/**
 * Prefix of the sessionStorage keys recording the activity day (ADR 0086): `<prefix>:<userId>`
 * holds the latest UTC day this browser tab recorded for that user. One key per user, so
 * signing in as another account in the same tab and back again doesn't send a day twice.
 * Written only after the server accepted the day, so a failed ping is retried on the next mount.
 */
export const ACTIVITY_DAY_STORAGE_KEY = "drafto:activity-day";

const DAY_MS = 86_400_000;
// The rollover check runs this long after midnight UTC, so a timer that fires a little early
// still lands on the new day.
const ROLLOVER_DELAY_MS = 5_000;

// The guards live at module level, not in the component: React StrictMode runs effects
// twice in development, and a remount must not send the same day again while the first
// call is still on its way. Both hold `<userId>:<day>` markers.
const inFlightMarkers = new Set<string>();
// Fallback for a tab whose sessionStorage is unavailable (private mode, storage disabled):
// without it every remount in that page would send the day again.
const recordedMarkers = new Set<string>();
// A ping that fails once (offline, expired session) tends to fail on every retry, and each
// failure is the same signal, so only the first one in a page session reaches Sentry.
let failureReported = false;

function storageKey(userId: string): string {
  return `${ACTIVITY_DAY_STORAGE_KEY}:${userId}`;
}

function readStoredDay(userId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(userId));
  } catch {
    // Storage is unavailable: behave as if nothing was recorded. At worst the server sees
    // a day it already has, which it ignores.
    return null;
  }
}

function storeDay(userId: string, day: string): void {
  try {
    const key = storageKey(userId);
    const stored = window.sessionStorage.getItem(key);
    // A ping for an earlier day that answers after a later day's must not move the marker back.
    if (stored !== null && stored > day) return;
    window.sessionStorage.setItem(key, day);
  } catch {
    // Storage is unavailable: `recordedMarkers` still prevents repeats in this page.
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

async function sendPing(userId: string, day: string, marker: string): Promise<void> {
  inFlightMarkers.add(marker);
  try {
    // recordActivity never throws; the try/catch covers creating the client.
    const outcome = await recordActivity(createClient(), [day], "web");
    if (outcome.ok) {
      recordedMarkers.add(marker);
      storeDay(userId, day);
    } else {
      reportFailure(outcome.error);
    }
  } catch (err) {
    reportFailure(err instanceof Error ? err.message : String(err));
  } finally {
    inFlightMarkers.delete(marker);
  }
}

/** Sends today's activity day for <userId> unless this tab already sent (or is sending) it. */
function pingActivity(userId: string): void {
  const day = utcDay();
  const marker = `${userId}:${day}`;
  if (inFlightMarkers.has(marker) || recordedMarkers.has(marker)) return;
  if (readStoredDay(userId) === day) return;
  // Fire-and-forget: sendPing handles its own errors, and rendering never waits for it.
  void sendPing(userId, day, marker);
}

/** Milliseconds from <now> until just after the next midnight UTC. */
function untilNextUtcDay(now: number = Date.now()): number {
  return DAY_MS - (now % DAY_MS) + ROLLOVER_DELAY_MS;
}

/**
 * Records that the signed-in user opened Drafto today (UTC), from the web, at most once per
 * browser session per UTC day (ADR 0086). Only the day is sent: never a note, page or action.
 *
 * The ping runs in an effect, after render, and is never awaited. It runs again when the user
 * returns to the tab and at midnight UTC while the tab is in front, so a new day is recorded.
 * A failure leaves the day unmarked, so the next mount tries again, and is reported to Sentry
 * as a warning at most once per page session.
 */
export function useActivityPing(userId: string): void {
  useEffect(() => {
    pingActivity(userId);

    // In-app navigation doesn't remount the app layout, so a tab left open across midnight
    // UTC would otherwise never record the new day. Check again whenever the user comes back
    // to the tab, and at each midnight UTC while the tab stays in front; on a day already
    // recorded this is a no-op. A tab hidden at midnight records the day when it is shown.
    const onReturn = () => {
      if (document.visibilityState === "visible") pingActivity(userId);
    };
    let rollover: ReturnType<typeof setTimeout>;
    const scheduleRollover = () => {
      rollover = setTimeout(() => {
        onReturn();
        scheduleRollover();
      }, untilNextUtcDay());
    };
    scheduleRollover();
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      clearTimeout(rollover);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [userId]);
}
