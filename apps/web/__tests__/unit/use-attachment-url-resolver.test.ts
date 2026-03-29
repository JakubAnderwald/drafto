import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAttachmentUrlResolver } from "@/components/editor/use-attachment-url-resolver";

const mockFetch = vi.fn();

describe("useAttachmentUrlResolver", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns non-attachment URLs unchanged without calling fetch", async () => {
    const { result } = renderHook(() => useAttachmentUrlResolver());
    const resolver = result.current;

    const signedUrl =
      "https://test.supabase.co/storage/v1/object/sign/attachments/u/n/img.png?token=abc";
    const resolved = await resolver(signedUrl);

    expect(resolved).toBe(signedUrl);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves attachment:// URLs via the resolve-url API", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          signedUrl:
            "https://test.supabase.co/storage/v1/object/sign/attachments/u/n/img.png?token=fresh",
        }),
    });

    const { result } = renderHook(() => useAttachmentUrlResolver());
    const resolver = result.current;

    const resolved = await resolver("attachment://u/n/img.png");

    expect(resolved).toBe(
      "https://test.supabase.co/storage/v1/object/sign/attachments/u/n/img.png?token=fresh",
    );
    expect(mockFetch).toHaveBeenCalledWith("/api/attachments/resolve-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "u/n/img.png" }),
    });
  });

  it("resolves different attachment URLs independently", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ signedUrl: "https://test.supabase.co/signed?token=first" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ signedUrl: "https://test.supabase.co/signed?token=second" }),
      });

    const { result } = renderHook(() => useAttachmentUrlResolver());
    const resolver = result.current;

    const first = await resolver("attachment://u/n/img1.png");
    const second = await resolver("attachment://u/n/img2.png");

    expect(first).toBe("https://test.supabase.co/signed?token=first");
    expect(second).toBe("https://test.supabase.co/signed?token=second");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws when the API returns an error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Forbidden" }),
    });

    const { result } = renderHook(() => useAttachmentUrlResolver());
    const resolver = result.current;

    await expect(resolver("attachment://u/n/img.png")).rejects.toThrow(
      "Failed to resolve attachment URL",
    );
  });
});
