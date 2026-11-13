import {
  addDay,
  isDraftoClientTag,
  isUtcDay,
  normalizeActivityQueue,
  recordActivity,
  utcDay,
  withoutSent,
} from "@drafto/shared";
import type { ActivityRpcClient } from "@drafto/shared";

/**
 * Activity days (ADR-0077, docs/features/offline-sync.md): the UTC days on
 * which this device opened Drafto. Each sync marks today, and a sync that gets
 * through sends every queued day to `record_activity`, so days opened offline
 * still count. Nothing else is recorded: no note, screen or action.
 *
 * The queue lives in WatermelonDB's localStorage, not in AsyncStorage or the
 * keychain, because `unsafeResetDatabase` (sign-out, a different user signing
 * in) clears it with the notes: one user's days are never sent under another
 * user's session.
 *
 * apps/mobile/src/db/activity-days.ts and apps/desktop/src/db/activity-days.ts
 * are identical; change both.
 */

const STORAGE_KEY = "drafto_activity_days";

/** What is stored under STORAGE_KEY. */
export interface ActivityDaysState {
  /** Days opened that the server hasn't recorded yet, oldest first, at most 30. */
  days: string[];
  /** The newest day the server has recorded from this device, or null. */
  lastSent: string | null;
}

/** The part of WatermelonDB's `LocalStorage` this module uses. */
export interface ActivityDaysStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: ActivityDaysState): Promise<void>;
}

/**
 * The part of a WatermelonDB `Database` this module uses. A real database
 * always has `localStorage`; a test double without one makes both functions
 * below do nothing.
 */
export interface ActivityDaysDatabase {
  readonly localStorage?: ActivityDaysStorage;
}

// Every read-modify-write of the stored state runs in this chain, one at a
// time. A sync marks today while an earlier sync's flush may be writing its
// result back, and interleaving their reads and writes would drop a day.
let stateLock: Promise<void> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = stateLock.then(task);
  stateLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The stored state; a missing or malformed value reads as an empty queue. */
async function readState(storage: ActivityDaysStorage): Promise<ActivityDaysState> {
  const stored = await storage.get(STORAGE_KEY);
  if (typeof stored !== "object" || stored === null) return { days: [], lastSent: null };
  const { days, lastSent } = stored as Partial<Record<keyof ActivityDaysState, unknown>>;
  return { days: normalizeActivityQueue(days), lastSent: isUtcDay(lastSent) ? lastSent : null };
}

function newerDay(a: string | null, b: string | undefined): string | null {
  if (b === undefined) return a;
  return a === null || b > a ? b : a;
}

/**
 * Queues <now>'s UTC day. Once the server has recorded today from this device,
 * marking it again adds nothing, so the queue stays empty until the next UTC
 * day and a device pings at most once a day. Never rejects; a storage failure
 * is only logged (native has no Sentry).
 */
export async function markAppOpened(
  db: ActivityDaysDatabase,
  now: Date = new Date(),
): Promise<void> {
  try {
    const storage = db.localStorage;
    if (!storage) return;
    await exclusive(async () => {
      const today = utcDay(now);
      const state = await readState(storage);
      if (today === state.lastSent || state.days.includes(today)) return;
      await storage.set(STORAGE_KEY, { ...state, days: addDay(state.days, today) });
    });
  } catch (error) {
    console.warn("[activity-days] Could not queue today's activity day:", error);
  }
}

/**
 * Sends every queued day to `record_activity` as <clientTag>, then drops the
 * days the server took. A failed call keeps the queue for the next sync to
 * retry. Never rejects, so a failed ping can't fail the sync that runs it.
 */
export async function flushActivityDays(
  db: ActivityDaysDatabase,
  client: ActivityRpcClient,
  clientTag: string,
): Promise<void> {
  try {
    // Mobile tags a build on any platform but iOS or Android "mobile", which
    // usage_daily rejects, so such a build keeps its queue and never pings.
    if (!isDraftoClientTag(clientTag)) return;
    const storage = db.localStorage;
    if (!storage) return;

    // The call runs outside the lock, so marking a day never waits on the network.
    const { days } = await exclusive(() => readState(storage));
    if (days.length === 0) return;

    const outcome = await recordActivity(client, days, clientTag);
    if (!outcome.ok) {
      console.warn(
        `[activity-days] Activity ping failed; ${days.length} day(s) kept for the next sync:`,
        outcome.error,
      );
      return;
    }

    const { sent } = outcome;
    await exclusive(async () => {
      // Read again: a day queued while the call was in flight must stay queued.
      const current = await readState(storage);
      await storage.set(STORAGE_KEY, {
        days: withoutSent(current.days, sent),
        lastSent: newerDay(current.lastSent, sent[sent.length - 1]),
      });
    });
  } catch (error) {
    console.warn("[activity-days] Could not send queued activity days:", error);
  }
}
