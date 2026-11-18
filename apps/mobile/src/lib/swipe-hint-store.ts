import * as SecureStore from "expo-secure-store";

/** The lists whose rows hide actions behind a swipe, each with its own one-time hint. */
export type SwipeHintList = "notes" | "trash" | "notebooks";

const SWIPE_HINT_KEY_PREFIX = "drafto_swipe_hint_seen_";
const SWIPE_PEEK_KEY_PREFIX = "drafto_swipe_hint_peeked_";
const SET = "1";

// Per-device UI flags, kept in expo-secure-store like the theme preference:
// the app has no other key-value store outside its database, which sign-out
// wipes. They are not tied to an account, so sign-out leaves them alone.

/** The "hint dismissed" flag of one list. */
export function swipeHintKey(list: SwipeHintList): string {
  return `${SWIPE_HINT_KEY_PREFIX}${list}`;
}

/** The "first row has slid once" flag of one list. */
export function swipePeekKey(list: SwipeHintList): string {
  return `${SWIPE_PEEK_KEY_PREFIX}${list}`;
}

export async function hasSeenSwipeHint(list: SwipeHintList): Promise<boolean> {
  return (await SecureStore.getItemAsync(swipeHintKey(list))) === SET;
}

export async function markSwipeHintSeen(list: SwipeHintList): Promise<void> {
  await SecureStore.setItemAsync(swipeHintKey(list), SET);
}

export async function hasPeekedSwipeHint(list: SwipeHintList): Promise<boolean> {
  return (await SecureStore.getItemAsync(swipePeekKey(list))) === SET;
}

export async function markSwipeHintPeeked(list: SwipeHintList): Promise<void> {
  await SecureStore.setItemAsync(swipePeekKey(list), SET);
}
