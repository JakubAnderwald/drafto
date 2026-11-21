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
 * Activity days (ADR-0088, docs/features/offline-sync.md): the UTC days on
 * which this device opened Drafto. A sync started while the app is in front
 * marks today, and so does the app coming to the front (`DatabaseProvider`'s
 * `AppState` listener), because the sync it starts can join a pass started in
 * the background. Any sync that gets through sends every queued day to
 * `record_activity`, so days opened offline still count. Nothing else is
 * recorded: no note, screen or action.
 *
 * The queue lives in WatermelonDB's localStorage, not in AsyncStorage or the
 * keychain, because `unsafeResetDatabase` (sign-out, a different user signing
 * in) clears it with the notes. Sign-out also calls `invalidateActivityDays()`
 * (through `resetSyncState()`) before that reset, so a mark or flush started
 * for the user signing out writes nothing into the next user's queue.
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

// Bumped by invalidateActivityDays(). A mark or flush captures the generation
// it started under and writes only while it is still current.
let generation = 0;

/**
 * Stops every mark and flush already started from writing the stored state.
 * Sign-out calls it, through `resetSyncState()`, before the local database is
 * reset: work started for the user signing out (a flush whose call is still
 * out, a mark waiting for the lock) would otherwise write that user's
 * `lastSent` or days into the next user's queue once the reset has cleared it.
 */
export function invalidateActivityDays(): void {
  generation += 1;
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
    const started = generation;
    await exclusive(async () => {
      const today = utcDay(now);
      const state = await readState(storage);
      if (generation !== started) return;
      // A lastSent after today was sent while this device's clock ran ahead.
      // The server drops days after its own today, so it never recorded that
      // day, which mustn't be held back when it really comes.
      const lastSent = state.lastSent !== null && state.lastSent > today ? null : state.lastSent;
      const known = today === lastSent || state.days.includes(today);
      if (known && lastSent === state.lastSent) return;
      await storage.set(STORAGE_KEY, {
        days: known ? state.days : addDay(state.days, today),
        lastSent,
      });
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
    const started = generation;

    // The call runs outside the lock, so marking a day never waits on the network.
    const { days } = await exclusive(() => readState(storage));
    if (days.length === 0 || generation !== started) return;

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
      // Invalidated while the call was out: this state may be the next user's.
      if (generation !== started) return;
      await storage.set(STORAGE_KEY, {
        days: withoutSent(current.days, sent),
        lastSent: newerDay(current.lastSent, sent[sent.length - 1]),
      });
    });
  } catch (error) {
    console.warn("[activity-days] Could not send queued activity days:", error);
  }
}
