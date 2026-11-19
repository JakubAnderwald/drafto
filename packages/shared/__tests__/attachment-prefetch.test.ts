import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREFETCH_MIN_INTERVAL_MS,
  createAttachmentPrefetcher,
  type AttachmentPrefetchDeps,
} from "../src/storage/attachment-prefetch";

const candidate = (filePath: string, fileSize: number) => ({ filePath, fileSize });

function setup(overrides: Partial<AttachmentPrefetchDeps> = {}) {
  let clock = 100_000;
  const deps = {
    listCandidates: vi.fn(async () => [candidate("a", 10), candidate("b", 10)]),
    cacheState: vi.fn(async () => ({ isCached: () => false, totalBytes: 0 })),
    maxCacheBytes: 1000,
    limits: { maxFiles: 2, maxBytes: 500, maxFileBytes: 300 },
    getSignedUrl: vi.fn(async (filePath: string) => `https://signed/${filePath}`),
    download: vi.fn(async (filePath: string) => `file:///c/${filePath}`),
    evict: vi.fn(async () => undefined),
    now: () => clock,
    ...overrides,
  };
  return {
    deps,
    prefetcher: createAttachmentPrefetcher(deps),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createAttachmentPrefetcher", () => {
  it("downloads what the policy picks, within the cache's free room, then evicts", async () => {
    const { deps, prefetcher } = setup({
      listCandidates: vi.fn(async () => [
        candidate("cached", 10),
        candidate("huge", 301),
        candidate("a", 100),
        candidate("b", 100),
        candidate("c", 100),
      ]),
      cacheState: vi.fn(async () => ({ isCached: (p: string) => p === "cached", totalBytes: 850 })),
    });
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 1 });
    expect(vi.mocked(deps.download).mock.calls.map(([filePath]) => filePath)).toEqual(["a"]);
    expect(deps.download).toHaveBeenCalledWith("a", "https://signed/a");
    expect(deps.evict).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failure (the network went away)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, prefetcher } = setup({
      getSignedUrl: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 0 });
    expect(deps.getSignedUrl).toHaveBeenCalledTimes(1);
    expect(deps.evict).not.toHaveBeenCalled();
  });

  it("does not start the throttle after a pass that stopped on a failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, prefetcher } = setup({
      getSignedUrl: vi
        .fn<AttachmentPrefetchDeps["getSignedUrl"]>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(async (filePath: string) => `https://signed/${filePath}`),
    });
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 0 });
    // Right after (a reconnect's sync), the next pass picks up the rest.
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 2 });
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("does not start the throttle after a pass that failed outright", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, prefetcher } = setup({
      listCandidates: vi
        .fn<AttachmentPrefetchDeps["listCandidates"]>()
        .mockRejectedValueOnce(new Error("db"))
        .mockResolvedValue([candidate("a", 10)]),
    });
    await prefetcher.prefetch();
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 1 });
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("stops once the session ends", async () => {
    const { deps, prefetcher } = setup();
    let calls = 0;
    await prefetcher.prefetch({ isCancelled: () => calls++ > 1 });
    expect(deps.download).not.toHaveBeenCalled();
  });

  it("does not repeat a pass that found nothing for a minute", async () => {
    const { deps, prefetcher, advance } = setup({ listCandidates: vi.fn(async () => []) });
    await prefetcher.prefetch();
    await prefetcher.prefetch();
    expect(deps.listCandidates).toHaveBeenCalledTimes(1);
    advance(PREFETCH_MIN_INTERVAL_MS);
    await prefetcher.prefetch();
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
  });

  it("runs one pass at a time", async () => {
    const { prefetcher } = setup();
    const first = prefetcher.prefetch();
    expect(prefetcher.prefetch()).toBe(first);
    await first;
  });

  it("starts a pass of its own instead of joining one whose session ended", async () => {
    let finishSignedUrl: (url: string) => void = () => undefined;
    const { deps, prefetcher } = setup({
      getSignedUrl: vi
        .fn<AttachmentPrefetchDeps["getSignedUrl"]>()
        .mockImplementationOnce(() => new Promise((resolve) => (finishSignedUrl = resolve)))
        .mockImplementation(async (filePath: string) => `https://signed/${filePath}`),
    });
    let oldSessionEnded = false;
    const old = prefetcher.prefetch({ isCancelled: () => oldSessionEnded });
    await vi.waitFor(() => expect(deps.getSignedUrl).toHaveBeenCalledTimes(1));

    // Approval revoked and restored: the new session's sync asks for a pass.
    oldSessionEnded = true;
    const fresh = prefetcher.prefetch({ isCancelled: () => false });
    expect(fresh).not.toBe(old);

    finishSignedUrl("https://signed/a");
    await expect(old).resolves.toEqual({ downloaded: 0 });
    await expect(fresh).resolves.toEqual({ downloaded: 2 });

    // Neither the dropped pass nor the cancelled one started the throttle.
    vi.mocked(deps.listCandidates).mockResolvedValue([]);
    await prefetcher.prefetch();
    expect(deps.listCandidates).toHaveBeenCalledTimes(3);
  });

  it("does not start the throttle after a pass its session's end cut short", async () => {
    const { deps, prefetcher } = setup();
    await prefetcher.prefetch({ isCancelled: () => true });
    expect(deps.download).not.toHaveBeenCalled();
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 2 });
  });

  it("never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { prefetcher } = setup({
      listCandidates: vi.fn(async () => {
        throw new Error("db");
      }),
    });
    await expect(prefetcher.prefetch()).resolves.toEqual({ downloaded: 0 });
  });

  it("reset drops the running pass, so the next account's pass starts at once", async () => {
    let finishDownload: (uri: string | null) => void = () => undefined;
    const { deps, prefetcher } = setup({
      download: vi
        .fn<AttachmentPrefetchDeps["download"]>()
        .mockImplementationOnce(() => new Promise((resolve) => (finishDownload = resolve)))
        .mockImplementation(async (filePath: string) => `file:///c/${filePath}`),
    });
    const old = prefetcher.prefetch();
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalledTimes(1));

    prefetcher.reset();
    const fresh = prefetcher.prefetch();
    expect(fresh).not.toBe(old);

    // The old pass stops before its next download and doesn't evict.
    finishDownload(null);
    await expect(old).resolves.toEqual({ downloaded: 0 });
    await expect(fresh).resolves.toEqual({ downloaded: 2 });
    expect(deps.download).toHaveBeenCalledTimes(3);
    expect(deps.evict).toHaveBeenCalledTimes(1);

    // The old, idle pass did not set the throttle: a pass right after runs.
    vi.mocked(deps.listCandidates).mockResolvedValue([]);
    await prefetcher.prefetch();
    expect(deps.listCandidates).toHaveBeenCalledTimes(3);
  });

  it("lets a download the sign-out overtook finish without evicting or counting toward the next pass", async () => {
    let finishDownload: (uri: string | null) => void = () => undefined;
    const { deps, prefetcher } = setup({
      download: vi
        .fn<AttachmentPrefetchDeps["download"]>()
        .mockImplementationOnce(() => new Promise((resolve) => (finishDownload = resolve)))
        .mockImplementation(async (filePath: string) => `file:///c/${filePath}`),
    });
    const old = prefetcher.prefetch();
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalledTimes(1));
    prefetcher.reset();

    // The old download completes successfully after the wipe. The native
    // downloadToCache resolves null then and deletes its file (its own tests
    // cover that); even a URI here must not let the old pass go on.
    finishDownload("file:///c/a");
    await old;
    expect(deps.download).toHaveBeenCalledTimes(1);
    expect(deps.evict).not.toHaveBeenCalled();

    vi.mocked(deps.listCandidates).mockResolvedValue([]);
    await prefetcher.prefetch();
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
  });
});
