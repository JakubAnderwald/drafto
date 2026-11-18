import * as SecureStore from "expo-secure-store";

import {
  hasPeekedSwipeHint,
  hasSeenSwipeHint,
  markSwipeHintPeeked,
  markSwipeHintSeen,
  swipeHintKey,
  swipePeekKey,
} from "@/lib/swipe-hint-store";

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe("swipe-hint-store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keys each list's flag separately", () => {
    expect(swipeHintKey("notes")).toBe("drafto_swipe_hint_seen_notes");
    expect(swipeHintKey("trash")).toBe("drafto_swipe_hint_seen_trash");
    expect(swipeHintKey("notebooks")).toBe("drafto_swipe_hint_seen_notebooks");
  });

  it("reports an unseen hint when nothing is stored", async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);

    await expect(hasSeenSwipeHint("notes")).resolves.toBe(false);
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_notes");
  });

  it("reports a seen hint once the flag is stored", async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce("1");

    await expect(hasSeenSwipeHint("trash")).resolves.toBe(true);
  });

  it("treats any other stored value as unseen", async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce("0");

    await expect(hasSeenSwipeHint("notebooks")).resolves.toBe(false);
  });

  it("passes a read failure on to the caller", async () => {
    mockSecureStore.getItemAsync.mockRejectedValueOnce(new Error("keychain locked"));

    await expect(hasSeenSwipeHint("notes")).rejects.toThrow("keychain locked");
  });

  it("stores the flag for one list", async () => {
    await markSwipeHintSeen("trash");

    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_trash", "1");
  });

  it("keys each list's peek flag apart from its hint flag", () => {
    expect(swipePeekKey("notes")).toBe("drafto_swipe_hint_peeked_notes");
    expect(swipePeekKey("trash")).toBe("drafto_swipe_hint_peeked_trash");
    expect(swipePeekKey("notebooks")).toBe("drafto_swipe_hint_peeked_notebooks");
  });

  it("reports whether the first-row peek has played", async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null).mockResolvedValueOnce("1");

    await expect(hasPeekedSwipeHint("notes")).resolves.toBe(false);
    await expect(hasPeekedSwipeHint("notes")).resolves.toBe(true);
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_peeked_notes");
  });

  it("stores the peek flag for one list", async () => {
    await markSwipeHintPeeked("notebooks");

    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      "drafto_swipe_hint_peeked_notebooks",
      "1",
    );
  });
});
