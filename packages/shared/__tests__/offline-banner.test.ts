import { describe, expect, it } from "vitest";

import {
  RECONNECTED_HOLD_MS,
  initialOfflineBannerVariant,
  nextOfflineBannerVariant,
  type OfflineBannerEvent,
  type OfflineBannerVariant,
} from "../src/network/offline-banner";

const ONLINE: OfflineBannerEvent = { type: "connection", isConnected: true };
const OFFLINE: OfflineBannerEvent = { type: "connection", isConnected: false };
const HOLD_ELAPSED: OfflineBannerEvent = { type: "holdElapsed" };

/** Runs a sequence of events from a starting banner, returning each banner on the way. */
function run(start: OfflineBannerVariant | null, events: OfflineBannerEvent[]) {
  const seen: (OfflineBannerVariant | null)[] = [];
  let variant = start;
  for (const event of events) {
    variant = nextOfflineBannerVariant(variant, event);
    seen.push(variant);
  }
  return seen;
}

describe("offline banner state machine", () => {
  it("holds 'Back online' for two seconds", () => {
    expect(RECONNECTED_HOLD_MS).toBe(2000);
  });

  it("shows nothing for an app that starts online, and 'offline' for one that starts offline", () => {
    expect(initialOfflineBannerVariant(true)).toBeNull();
    expect(initialOfflineBannerVariant(false)).toBe("offline");
  });

  it("goes offline, then 'reconnected', then hides when the hold ends", () => {
    expect(run(null, [OFFLINE, ONLINE, HOLD_ELAPSED])).toEqual(["offline", "reconnected", null]);
  });

  it("goes straight back to 'offline' when the connection drops during the hold", () => {
    expect(run("reconnected", [OFFLINE])).toEqual(["offline"]);
  });

  it("ignores a stale hold that ends while offline again", () => {
    expect(run("offline", [HOLD_ELAPSED])).toEqual(["offline"]);
    expect(run(null, [HOLD_ELAPSED])).toEqual([null]);
  });

  it("does not show 'reconnected' for a connection that never dropped", () => {
    expect(run(null, [ONLINE, ONLINE])).toEqual([null, null]);
  });

  it("keeps 'reconnected' through a repeated online report until the hold ends", () => {
    expect(run("reconnected", [ONLINE, HOLD_ELAPSED])).toEqual(["reconnected", null]);
  });

  it("stays 'offline' through repeated offline reports", () => {
    expect(run("offline", [OFFLINE, OFFLINE])).toEqual(["offline", "offline"]);
  });
});
