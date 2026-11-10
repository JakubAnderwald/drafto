import { useCallback, useRef } from "react";

/** How a delete or move request from the note list ended. */
export type NoteRemovalOutcome = "removed" | "failed" | "signed-out";

interface UseNoteRemovalsOptions {
  /**
   * The server removed `noteId` from the list. Move the selection to `nextSelectedId`
   * if `noteId` is still the selected note.
   */
  onRemoved: (noteId: string, nextSelectedId: string | null) => void;
  /** Refetch the list. */
  onRefresh: () => void;
}

interface NoteRemovals {
  /** Call before sending the request that deletes or moves `noteId`. */
  beginRemoval: (noteId: string) => void;
  /**
   * Call once that request has settled. `remainingIds` is the list, in order, as
   * the user saw it after the note's row was removed.
   */
  settleRemoval: (
    noteId: string,
    remainingIds: readonly string[],
    outcome: NoteRemovalOutcome,
  ) => void;
}

/**
 * Follows up the deletes and moves the note list sends, which can overlap when the
 * user removes notes faster than the server answers (#461).
 *
 * - The next selection is chosen when a request lands, not when the user clicked:
 *   the first remaining note whose own removal isn't in flight or already done. A
 *   choice made at click time can name a note that a later removal has since taken
 *   away, and the editor would then open a trashed note.
 * - The list is refetched once, after the last overlapping request settles. A
 *   refetch while another request is in flight can return that request's note
 *   again.
 *
 * A failed request only refreshes. Its note was never deselected, so it comes back
 * selected, and it can again be picked as the next selection.
 */
export function useNoteRemovals({ onRemoved, onRefresh }: UseNoteRemovalsOptions): NoteRemovals {
  // Cleared whenever nothing is in flight: a removed note restored from the trash
  // later must be selectable again.
  const burst = useRef({ inFlight: 0, noteIds: new Set<string>(), refreshDue: false });

  const beginRemoval = useCallback((noteId: string) => {
    burst.current.inFlight += 1;
    burst.current.noteIds.add(noteId);
  }, []);

  const settleRemoval = useCallback(
    (noteId: string, remainingIds: readonly string[], outcome: NoteRemovalOutcome) => {
      const state = burst.current;
      state.inFlight -= 1;

      if (outcome === "removed") {
        onRemoved(noteId, remainingIds.find((id) => !state.noteIds.has(id)) ?? null);
        state.refreshDue = true;
      } else if (outcome === "failed") {
        state.noteIds.delete(noteId);
        state.refreshDue = true;
      }
      // "signed-out": the page is already on its way to the sign-in screen.

      if (state.inFlight === 0) {
        state.noteIds.clear();
        if (state.refreshDue) {
          state.refreshDue = false;
          onRefresh();
        }
      }
    },
    [onRemoved, onRefresh],
  );

  return { beginRemoval, settleRemoval };
}
