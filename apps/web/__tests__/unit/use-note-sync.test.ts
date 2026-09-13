import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockHandleAuthError = vi.fn<(res: Response) => boolean>(() => false);
vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: (res: Response) => mockHandleAuthError(res),
}));

type NoteRow = { id: string; updated_at: string; is_trashed: boolean };

type RealtimePayload =
  { eventType: "INSERT" | "UPDATE"; new: NoteRow } | { eventType: "DELETE"; old: { id: string } };

interface Subscription {
  topic: string;
  config: Record<string, string>;
  handler: (payload: RealtimePayload) => void;
}

/** Every channel the hook opened, in order, plus the topics it later removed. */
const subscriptions: Subscription[] = [];
const removedTopics: string[] = [];

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel(topic: string) {
      const subscription: Subscription = { topic, config: {}, handler: () => {} };
      const channel = {
        topic,
        on(
          _event: string,
          config: Record<string, string>,
          handler: (payload: RealtimePayload) => void,
        ) {
          subscription.config = config;
          subscription.handler = handler;
          return channel;
        },
        subscribe() {
          subscriptions.push(subscription);
          return channel;
        },
      };
      return channel;
    },
    removeChannel(channel: { topic: string }) {
      removedTopics.push(channel.topic);
    },
  }),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Type-only import: erased at compile time, so it cannot defeat the mocks above.
import type { NoteSnapshot } from "@/hooks/use-note-sync";

const { useNoteSync } = await import("@/hooks/use-note-sync");

const NOTE_ID = "note-1";
/** What the caller is already showing — anything at or before this is our own echo. */
const SYNCED_AT = "2026-09-06T12:00:00.000+00:00";
const NEWER = "2026-09-06T12:05:00.000+00:00";

const remoteNote: NoteSnapshot = {
  id: NOTE_ID,
  title: "Shared note",
  content: null,
  created_at: "2026-09-06T10:00:00.000+00:00",
  updated_at: NEWER,
  is_trashed: false,
};

function respondWith(note: Partial<NoteSnapshot> = {}) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ...remoteNote, ...note }),
  });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

function mount(props: { noteId?: string; syncedAt?: string | null } = {}) {
  const onExternalChange = vi.fn();
  const view = renderHook(
    ({ noteId, syncedAt }: { noteId: string; syncedAt: string | null }) =>
      useNoteSync({ noteId, syncedAt, onExternalChange }),
    { initialProps: { noteId: props.noteId ?? NOTE_ID, syncedAt: props.syncedAt ?? SYNCED_AT } },
  );
  return { ...view, onExternalChange };
}

/** The channel most recently opened — the hook re-subscribes when `noteId` changes. */
function currentSubscription(): Subscription {
  const subscription = subscriptions.at(-1);
  if (!subscription) throw new Error("expected the hook to have opened a realtime channel");
  return subscription;
}

async function emit(payload: RealtimePayload) {
  await act(async () => {
    currentSubscription().handler(payload);
  });
}

function update(updated_at: string): RealtimePayload {
  return { eventType: "UPDATE", new: { id: NOTE_ID, updated_at, is_trashed: false } };
}

/** Let any in-flight refetch settle so "did not fetch" assertions are meaningful. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useNoteSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptions.length = 0;
    removedTopics.length = 0;
    mockHandleAuthError.mockReturnValue(false);
    setVisibility("visible");
    respondWith();
  });

  afterEach(() => {
    setVisibility("visible");
  });

  describe("subscription lifecycle", () => {
    it("subscribes to postgres_changes scoped to this note alone", () => {
      mount();

      expect(currentSubscription().config).toEqual({
        event: "*",
        schema: "public",
        table: "notes",
        filter: `id=eq.${NOTE_ID}`,
      });
    });

    it("removes the channel on unmount rather than leaking its rejoin timers", () => {
      const { unmount } = mount();
      const { topic } = currentSubscription();

      unmount();

      expect(removedTopics).toContain(topic);
    });

    it("gives each mount its own channel topic", () => {
      // The browser client is a singleton and returns the *existing* channel for a
      // duplicate topic, so a shared topic would let one unmount kill a live mount.
      const first = mount();
      const firstTopic = currentSubscription().topic;
      mount();

      expect(currentSubscription().topic).not.toBe(firstTopic);
      first.unmount();
    });

    it("re-subscribes when pointed at a different note", () => {
      const { rerender } = mount();

      rerender({ noteId: "note-2", syncedAt: SYNCED_AT });

      expect(subscriptions).toHaveLength(2);
      expect(currentSubscription().config.filter).toBe("id=eq.note-2");
    });
  });

  describe("echo suppression", () => {
    it("ignores an update at the caller's own watermark", async () => {
      mount();

      await emit(update(SYNCED_AT));
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("ignores an update older than the caller's watermark", async () => {
      mount();

      await emit(update("2026-09-06T11:00:00.000+00:00"));
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("recognises an echo delivered in Postgres wire format", async () => {
      // Realtime forwards `2026-09-06 12:00:00+00` for the instant PostgREST spells
      // `2026-09-06T12:00:00.000+00:00`. Compared as strings the space sorts first and
      // the echo would look newer, costing a refetch loop on every autosave.
      mount();

      await emit(update("2026-09-06 12:00:00+00"));
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("suppresses a duplicate delivery of a change it already reported", async () => {
      const { onExternalChange } = mount();

      await emit(update(NEWER));
      await waitFor(() => expect(onExternalChange).toHaveBeenCalledTimes(1));

      // Same change redelivered — now at the advanced watermark.
      await emit(update(NEWER));
      await settle();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(onExternalChange).toHaveBeenCalledTimes(1);
    });

    it("collapses concurrent triggers into a single request", async () => {
      let release: (() => void) | undefined;
      mockFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ ok: true, status: 200, json: () => Promise.resolve(remoteNote) });
          }),
      );
      mount();

      await emit(update(NEWER));
      await emit(update("2026-09-06T12:06:00.000+00:00"));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        release?.();
      });
    });
  });

  describe("reporting external changes", () => {
    it("refetches and reports an external edit", async () => {
      const { onExternalChange } = mount();

      await emit(update(NEWER));

      await waitFor(() =>
        expect(onExternalChange).toHaveBeenCalledWith({ kind: "updated", note: remoteNote }),
      );
      expect(mockFetch).toHaveBeenCalledWith(`/api/notes/${NOTE_ID}`);
    });

    it("reports an external edit announced in Postgres wire format", async () => {
      // The discriminating case for comparing by instant instead of by string:
      // Realtime's `2026-09-06 12:05:00+00` is genuinely newer than the ISO
      // watermark `2026-09-06T12:00:00.000+00:00`, but sorts *before* it lexically
      // (space < "T"), so a string compare would silently swallow the change.
      const { onExternalChange } = mount();

      await emit(update("2026-09-06 12:05:00+00"));

      await waitFor(() =>
        expect(onExternalChange).toHaveBeenCalledWith({ kind: "updated", note: remoteNote }),
      );
    });

    it("reports a trash performed elsewhere, which arrives as an UPDATE", async () => {
      respondWith({ is_trashed: true });
      const { onExternalChange } = mount();

      await emit(update(NEWER));

      await waitFor(() =>
        expect(onExternalChange).toHaveBeenCalledWith({
          kind: "trashed",
          note: { ...remoteNote, is_trashed: true },
        }),
      );
    });

    it("reports a hard delete without spending a refetch", async () => {
      const { onExternalChange } = mount();

      await emit({ eventType: "DELETE", old: { id: NOTE_ID } });

      expect(onExternalChange).toHaveBeenCalledWith({ kind: "deleted" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("reports deletion when the refetch 404s", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve(null) });
      const { onExternalChange } = mount();

      await emit(update(NEWER));

      await waitFor(() => expect(onExternalChange).toHaveBeenCalledWith({ kind: "deleted" }));
    });

    it("stops re-checking once the note is gone", async () => {
      const { onExternalChange } = mount();
      await emit({ eventType: "DELETE", old: { id: NOTE_ID } });
      onExternalChange.mockClear();

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(onExternalChange).not.toHaveBeenCalled();
    });
  });

  describe("waking the tab", () => {
    it("re-checks when the tab becomes visible", async () => {
      const { onExternalChange } = mount();

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await waitFor(() =>
        expect(onExternalChange).toHaveBeenCalledWith({ kind: "updated", note: remoteNote }),
      );
    });

    it("does not re-check while the tab is hidden", async () => {
      mount();
      setVisibility("hidden");

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("re-checks on window focus", async () => {
      mount();

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/api/notes/${NOTE_ID}`));
    });

    it("stays quiet when the wake-up finds nothing new", async () => {
      respondWith({ updated_at: SYNCED_AT });
      const { onExternalChange } = mount();

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await settle();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(onExternalChange).not.toHaveBeenCalled();
    });

    it("detaches its listeners on unmount", async () => {
      const { unmount } = mount();
      unmount();

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("transient failures", () => {
    it("keeps the current content on a server error and retries on the next wake-up", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve(null),
      });
      const { onExternalChange } = mount();

      await emit(update(NEWER));
      await settle();
      expect(onExternalChange).not.toHaveBeenCalled();

      // The watermark must not have advanced, or the retry would be suppressed.
      respondWith();
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() =>
        expect(onExternalChange).toHaveBeenCalledWith({ kind: "updated", note: remoteNote }),
      );
    });

    it("survives a network failure without reporting a change", async () => {
      mockFetch.mockRejectedValue(new Error("offline"));
      const { onExternalChange } = mount();

      await emit(update(NEWER));
      await settle();

      expect(onExternalChange).not.toHaveBeenCalled();
    });

    it("stops on an expired session instead of reporting a phantom change", async () => {
      mockHandleAuthError.mockReturnValue(true);
      const { onExternalChange } = mount();

      await emit(update(NEWER));
      await settle();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(onExternalChange).not.toHaveBeenCalled();
    });
  });

  describe("watermark bookkeeping", () => {
    it("advances the watermark when the caller saves", async () => {
      const { rerender } = mount();

      // A local save wrote back a newer `updated_at`; its echo must stay suppressed.
      rerender({ noteId: NOTE_ID, syncedAt: NEWER });
      await emit(update(NEWER));
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("never moves the watermark backwards for the same note", async () => {
      const { rerender } = mount();

      rerender({ noteId: NOTE_ID, syncedAt: "2026-09-06T08:00:00.000+00:00" });
      await emit(update("2026-09-06T09:00:00.000+00:00"));
      await settle();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("re-seeds — rather than carries over — the watermark for a different note", async () => {
      // note-2's timestamps are unrelated to note-1's; carrying the old watermark
      // over would silently swallow real changes to the newly-opened note.
      const { rerender, onExternalChange } = mount();

      rerender({ noteId: "note-2", syncedAt: "2026-09-06T09:00:00.000+00:00" });
      respondWith({ id: "note-2", updated_at: "2026-09-06T10:00:00.000+00:00" });
      await emit(update("2026-09-06T10:00:00.000+00:00"));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/notes/note-2"));
      expect(onExternalChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "updated" }));
    });

    it("clears the deleted latch when a different note is opened", async () => {
      const { rerender } = mount();
      await emit({ eventType: "DELETE", old: { id: NOTE_ID } });

      rerender({ noteId: "note-2", syncedAt: "2026-09-06T09:00:00.000+00:00" });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/api/notes/note-2"));
    });
  });
});
