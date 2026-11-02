import { describe, expect, it } from "vitest";
import { isMacDesktop } from "@/lib/auth/is-mac-desktop";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
// iPadOS Safari "Request Desktop Website" sends the Mac user agent verbatim.
const IPAD_DESKTOP_MODE = MAC_SAFARI;
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("isMacDesktop", () => {
  it.each([
    ["Chrome on a Mac", MAC_CHROME, 0],
    ["Safari on a Mac", MAC_SAFARI, 0],
    ["a Mac with a single-touch input", MAC_SAFARI, 1],
  ])("is true for %s", (_label, userAgent, maxTouchPoints) => {
    expect(isMacDesktop(userAgent, maxTouchPoints)).toBe(true);
  });

  it.each([
    ["an iPad in desktop mode", IPAD_DESKTOP_MODE, 5],
    ["an iPhone", IPHONE, 5],
    ["an Android phone", ANDROID, 5],
    ["Windows", WINDOWS, 0],
  ])("is false for %s", (_label, userAgent, maxTouchPoints) => {
    expect(isMacDesktop(userAgent, maxTouchPoints)).toBe(false);
  });
});
