import * as SecureStore from "expo-secure-store";

/** The lists whose rows hide actions behind a swipe, each with its own one-time hint. */
export type SwipeHintList = "notes" | "trash" | "notebooks";

const SWIPE_HINT_KEY_PREFIX = "drafto_swipe_hint_seen_";
const SEEN = "1";

// Per-device UI flags, like the theme preference: they are not tied to an
// account, so sign-out leaves them alone.
export function swipeHintKey(list: SwipeHintList): string {
  return `${SWIPE_HINT_KEY_PREFIX}${list}`;
}

export async function hasSeenSwipeHint(list: SwipeHintList): Promise<boolean> {
  return (await SecureStore.getItemAsync(swipeHintKey(list))) === SEEN;
}

export async function markSwipeHintSeen(list: SwipeHintList): Promise<void> {
  await SecureStore.setItemAsync(swipeHintKey(list), SEEN);
}
