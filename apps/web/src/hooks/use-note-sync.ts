"use client";

import { useCallback, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { handleAuthError } from "@/lib/handle-auth-error";
import { toEpochMs } from "@/lib/timestamps";

/**
 * Wire shape of `GET /api/notes/[id]`. Deliberately editor-agnostic — `content`
 * stays `unknown` so this module never depends on BlockNote.
 */
export interface NoteSnapshot {
  id: string;
  title: string;
  content: unknown;
  created_at: string;
  updated_at: string;
  is_trashed: boolean;
}

export type NoteSyncEvent =
  | { kind: "updated"; note: NoteSnapshot } // content/title changed elsewhere
  | { kind: "trashed"; note: NoteSnapshot } // soft-deleted elsewhere (an UPDATE in Postgres)
  | { kind: "deleted" }; // hard-deleted elsewhere

export interface UseNoteSyncOptions {
  noteId: string;
  /**
   * The newest server `updated_at` the caller already holds — the later of the
   * snapshot it is rendering and the last value its own save wrote back. Seeds and
   * advances the watermark that suppresses echoes of the caller's own writes.
   */
  syncedAt: string | null;
  /**
   * Invoked once per genuinely-external change. Called from a subscription callback,
   * never during render, so the handler is free to update state.
   */
  onExternalChange: (event: NoteSyncEvent) => void;
}

/**
 * Only the columns the realtime payload is actually read for. Must be a type alias
 * rather than an interface: realtime-js constrains its payload generic to
 * `{ [key: string]: any }`, which type aliases satisfy via an implicit index
 * signature and interfaces do not.
 */
type NoteRealtimeRow = {
  id: string;
  updated_at: string;
  is_trashed: boolean;
};

/**
 * Channel topics must be unique per mount. The Supabase browser client is a
 * singleton and `channel(topic)` returns the *existing* channel for a duplicate
 * topic, so a fixed topic would make a remount adopt a channel that the previous
 * unmount then tears down.
 */
let channelSeq = 0;

/**
 * Watches one note for changes made outside this tab — from another device, or
 * another browser tab — and reports them to the caller.
 *
 * Two independent signals feed one code path:
 *
 * 1. A Supabase Realtime `postgres_changes` subscription filtered to this note.
 * 2. A re-check whenever the tab regains visibility or focus.
 *
 * Realtime is only ever treated as a *signal*: the payload is not read for content
 * (a TOASTed, unchanged `content` column is omitted from the payload entirely, and
 * oversized records are stripped). The authoritative read is always the REST GET.
 * That also means the feature degrades to focus-driven refresh, rather than
 * breaking, if the Realtime publication is unavailable.
 *
 * Echoes of the caller's own writes are suppressed by a monotonic `updated_at`
 * watermark, which also absorbs duplicate and out-of-order delivery.
 */
export function useNoteSync({ noteId, syncedAt, onExternalChange }: UseNoteSyncOptions): void {
  const watermarkRef = useRef({ noteId, ms: toEpochMs(syncedAt) });
  const inFlightRef = useRef(false);
  const deletedRef = useRef(false);
  const handlerRef = useRef(onExternalChange);

  // Keep the handler current without making it an effect dependency — re-subscribing
  // on every render would tear the realtime channel down and up continuously.
  useEffect(() => {
    handlerRef.current = onExternalChange;
  });

  // The watermark only ever moves forward for a given note, but must be re-seeded
  // (not advanced) when pointed at a different note, whose timestamps are unrelated.
  // Declared before the subscription effects so it is current before any listener
  // that reads it can fire.
  useEffect(() => {
    const ms = toEpochMs(syncedAt);
    if (watermarkRef.current.noteId === noteId) {
      watermarkRef.current = { noteId, ms: Math.max(ms, watermarkRef.current.ms) };
    } else {
      watermarkRef.current = { noteId, ms };
      deletedRef.current = false;
    }
  }, [noteId, syncedAt]);

  const checkNow = useCallback(async () => {
    // Nothing to re-check once the note is gone, and a second trigger while a GET is
    // running is dropped — the next event or focus re-checks, so nothing is missed.
    if (deletedRef.current || inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const res = await fetch(`/api/notes/${noteId}`);
      if (handleAuthError(res)) return;

      if (res.status === 404) {
        deletedRef.current = true;
        handlerRef.current({ kind: "deleted" });
        return;
      }
      // Any other failure is treated as transient — keep showing what we have.
      if (!res.ok) return;

      const note: NoteSnapshot = await res.json();

      // At or behind the watermark means this is our own write coming back to us
      // (or a duplicate delivery). Trashing bumps `updated_at` too, so this single
      // check also stops an already-reported trash from being reported again.
      if (toEpochMs(note.updated_at) <= watermarkRef.current.ms) return;
      watermarkRef.current = { noteId, ms: toEpochMs(note.updated_at) };

      handlerRef.current(note.is_trashed ? { kind: "trashed", note } : { kind: "updated", note });
    } catch {
      // Offline or aborted — non-fatal by design; the next wake-up re-checks.
    } finally {
      inFlightRef.current = false;
    }
  }, [noteId]);

  useEffect(() => {
    const supabase = createClient();
    channelSeq += 1;

    const channel = supabase
      .channel(`note-sync:${noteId}:${channelSeq}`)
      .on<NoteRealtimeRow>(
        "postgres_changes",
        { event: "*", schema: "public", table: "notes", filter: `id=eq.${noteId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            if (deletedRef.current) return;
            deletedRef.current = true;
            handlerRef.current({ kind: "deleted" });
            return;
          }
          // Every local autosave round-trips as an UPDATE, because the
          // `on_notes_updated` trigger bumps `updated_at`. Filtering on the
          // watermark here — before spending a request — is what stops
          // save -> event -> refetch from looping.
          if (toEpochMs(payload.new.updated_at) <= watermarkRef.current.ms) return;
          void checkNow();
        },
      )
      .subscribe();

    return () => {
      // removeChannel (not channel.unsubscribe) — the latter skips teardown and
      // leaks the channel's rejoin timers.
      void supabase.removeChannel(channel);
    };
  }, [noteId, checkNow]);

  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") void checkNow();
    };

    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [checkNow]);
}
