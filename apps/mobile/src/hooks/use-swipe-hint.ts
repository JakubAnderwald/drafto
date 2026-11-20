import { useCallback, useEffect, useRef, useState } from "react";

import {
  hasPeekedSwipeHint,
  hasSeenSwipeHint,
  markSwipeHintPeeked,
  markSwipeHintSeen,
  type SwipeHintList,
} from "@/lib/swipe-hint-store";

export interface SwipeHint {
  /** Show the list-header hint. False until the stored flags have been read. */
  visible: boolean;
  /**
   * The id of the one row that slides to show what is under it, or null. It is
   * the list's first row when the peek was armed, so a row inserted above it
   * later doesn't take over (or replay) the peek.
   */
  peekRowId: string | null;
  /** Hide the hint for good: its close button, or the user's first real swipe. */
  dismiss: () => void;
  /** The first-row peek has played (or was skipped). Remembered, so it plays once per device. */
  endPeek: () => void;
}

/**
 * The one-time "these rows swipe" hint of one list (PrimeTestLab 10668 S-03).
 * Starts hidden so a returning user never sees it flash. The hint stays until
 * it is dismissed; the first-row slide plays once. Both are remembered per
 * list and per device.
 *
 * @param firstRowId the id of the list's first row right now, if it has one.
 */
export function useSwipeHint(list: SwipeHintList, firstRowId?: string): SwipeHint {
  const [visible, setVisible] = useState(false);
  // True until the stored flag says otherwise, so nothing slides before the read.
  const [peeked, setPeeked] = useState(true);
  const [armedRowId, setArmedRowId] = useState<string | null>(null);
  const dismissed = useRef(false);
  const peekEnded = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.all([hasSeenSwipeHint(list), hasPeekedSwipeHint(list)]).then(
      ([seen, hasPeeked]) => {
        if (!active || seen || dismissed.current) return;
        if (!hasPeeked && !peekEnded.current) setPeeked(false);
        setVisible(true);
      },
      // Can't tell: leave the hint hidden rather than show it on every visit.
      (error: unknown) => console.warn(`Could not read the ${list} swipe hint flag:`, error),
    );
    return () => {
      active = false;
    };
  }, [list]);

  // Arm the peek on the row that is first once it may play, and keep it there.
  const canPeek = visible && !peeked;
  if (canPeek && armedRowId === null && firstRowId) setArmedRowId(firstRowId);

  const dismiss = useCallback(() => {
    setVisible(false);
    if (dismissed.current) return;
    dismissed.current = true;
    markSwipeHintSeen(list).catch((error: unknown) =>
      console.warn(`Could not save the ${list} swipe hint flag:`, error),
    );
  }, [list]);

  const endPeek = useCallback(() => {
    if (peekEnded.current) return;
    peekEnded.current = true;
    setPeeked(true);
    markSwipeHintPeeked(list).catch((error: unknown) =>
      console.warn(`Could not save the ${list} swipe peek flag:`, error),
    );
  }, [list]);

  return { visible, peekRowId: canPeek ? armedRowId : null, dismiss, endPeek };
}
