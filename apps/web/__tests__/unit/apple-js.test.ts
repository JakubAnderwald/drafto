import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppleIdAuth } from "@/lib/apple/apple-js";

type AppleJsModule = typeof import("@/lib/apple/apple-js");

const SDK_SELECTOR = 'script[src*="appleid.auth.js"]';

function fakeAuth(): AppleIdAuth {
  return { init: vi.fn(), signIn: vi.fn() };
}

function setAppleId(value: unknown) {
  (window as Window & { AppleID?: unknown }).AppleID = value;
}

function sdkScripts(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>(SDK_SELECTOR));
}

async function freshModule(): Promise<AppleJsModule> {
  vi.resetModules();
  return import("@/lib/apple/apple-js");
}

describe("apple-js loader", () => {
  beforeEach(() => {
    delete (window as Window & { AppleID?: unknown }).AppleID;
    for (const script of sdkScripts()) script.remove();
  });

  afterEach(() => {
    delete (window as Window & { AppleID?: unknown }).AppleID;
    for (const script of sdkScripts()) script.remove();
  });

  it("loads Apple's script once for concurrent callers and resolves the API", async () => {
    const { loadAppleIdAuth, getLoadedAppleIdAuth, APPLE_JS_SDK_URL } = await freshModule();

    const first = loadAppleIdAuth();
    const second = loadAppleIdAuth();
    expect(second).toBe(first);
    expect(sdkScripts()).toHaveLength(1);
    expect(sdkScripts()[0]?.src).toBe(APPLE_JS_SDK_URL);
    expect(getLoadedAppleIdAuth()).toBeNull();

    const auth = fakeAuth();
    setAppleId({ auth });
    sdkScripts()[0]?.dispatchEvent(new Event("load"));

    await expect(first).resolves.toBe(auth);
    expect(getLoadedAppleIdAuth()).toBe(auth);
  });

  it("resolves the API without a request when it is already loaded", async () => {
    const { loadAppleIdAuth } = await freshModule();
    const auth = fakeAuth();
    setAppleId({ auth });

    await expect(loadAppleIdAuth()).resolves.toBe(auth);
    expect(sdkScripts()).toHaveLength(0);
  });

  it("resolves null when the script fails to load, and retries on the next call", async () => {
    const { loadAppleIdAuth } = await freshModule();

    const failed = loadAppleIdAuth();
    sdkScripts()[0]?.dispatchEvent(new Event("error"));
    await expect(failed).resolves.toBeNull();
    expect(sdkScripts()).toHaveLength(0);

    const retry = loadAppleIdAuth();
    expect(retry).not.toBe(failed);
    expect(sdkScripts()).toHaveLength(1);
  });

  it("resolves null when the script loads without a usable API", async () => {
    const { loadAppleIdAuth } = await freshModule();

    const load = loadAppleIdAuth();
    setAppleId({ auth: { init: "not a function" } });
    sdkScripts()[0]?.dispatchEvent(new Event("load"));

    await expect(load).resolves.toBeNull();
  });
});
