import { useCallback, useEffect, useRef, useState } from "react";

import { hasSeenSwipeHint, markSwipeHintSeen, type SwipeHintList } from "@/lib/swipe-hint-store";

export interface SwipeHint {
  /** Show the list-header hint. False until the stored flag has been read. */
  visible: boolean;
  /** Slide the first row once to show what is under it. */
  peek: boolean;
  /** Hide the hint for good: its close button, or the user's first real swipe. */
  dismiss: () => void;
  /** The first-row peek has played (or was skipped). */
  endPeek: () => void;
}

/**
 * The one-time "these rows swipe" hint of one list (PrimeTestLab 10668 S-03).
 * Starts hidden so a returning user never sees it flash, and remembers a
 * dismissal per device.
 */
export function useSwipeHint(list: SwipeHintList): SwipeHint {
  const [visible, setVisible] = useState(false);
  const [peeked, setPeeked] = useState(false);
  const dismissed = useRef(false);

  useEffect(() => {
    let active = true;
    hasSeenSwipeHint(list).then(
      (seen) => {
        if (active && !seen && !dismissed.current) setVisible(true);
      },
      // Can't tell: leave the hint hidden rather than show it on every visit.
      (error: unknown) => console.warn(`Could not read the ${list} swipe hint flag:`, error),
    );
    return () => {
      active = false;
    };
  }, [list]);

  const dismiss = useCallback(() => {
    setVisible(false);
    if (dismissed.current) return;
    dismissed.current = true;
    markSwipeHintSeen(list).catch((error: unknown) =>
      console.warn(`Could not save the ${list} swipe hint flag:`, error),
    );
  }, [list]);

  const endPeek = useCallback(() => setPeeked(true), []);

  return { visible, peek: visible && !peeked, dismiss, endPeek };
}
