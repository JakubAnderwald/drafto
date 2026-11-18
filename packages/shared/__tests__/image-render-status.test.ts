import { describe, expect, it } from "vitest";

import {
  IMAGE_RENDER_STATUS_MAX_IMAGES,
  IMAGE_RENDER_STATUS_MESSAGE_TYPE,
  IMAGE_RENDER_STATUS_SCRIPT,
  imageRenderStatusLabel,
  parseImageRenderStatus,
} from "../src/editor/image-render-status";

const message = (images: unknown, type: unknown = IMAGE_RENDER_STATUS_MESSAGE_TYPE) =>
  JSON.stringify({ type, images });

describe("parseImageRenderStatus", () => {
  it("reads the images of a report", () => {
    expect(
      parseImageRenderStatus(
        message([{ name: "photo.jpg", rendered: true, height: 240.4, local: true }]),
      ),
    ).toEqual([{ name: "photo.jpg", rendered: true, height: 240.4, local: true }]);
  });

  it("defaults a missing height and local flag, and drops malformed entries", () => {
    expect(
      parseImageRenderStatus(
        message([{ name: "a.png", rendered: false }, { rendered: true }, null, "x"]),
      ),
    ).toEqual([{ name: "a.png", rendered: false, height: 0, local: false }]);
  });

  it("caps the number of images", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `${i}.jpg`, rendered: true }));
    expect(parseImageRenderStatus(message(many))).toHaveLength(IMAGE_RENDER_STATUS_MAX_IMAGES);
  });

  it.each([
    ["not JSON", "not json"],
    ["another message type", message([], "draftoFindResult")],
    ["a report with no image list", message(undefined)],
    ["JSON null", "null"],
  ])("ignores %s", (_label, data) => {
    expect(parseImageRenderStatus(data)).toBeNull();
  });
});

describe("imageRenderStatusLabel", () => {
  it("ends with the image's name, so a photo's label ends in its extension", () => {
    expect(imageRenderStatusLabel({ name: "a.jpg", rendered: true, height: 1, local: true })).toBe(
      "Image shown: a.jpg",
    );
    expect(
      imageRenderStatusLabel({ name: "a.jpg", rendered: false, height: 0, local: false }),
    ).toBe("Image not loaded: a.jpg");
  });
});

describe("IMAGE_RENDER_STATUS_SCRIPT", () => {
  it("is valid JavaScript that posts the report message type", () => {
    // Parses without running it (the DOM it reads only exists in the WebView).
    expect(() => new Function(IMAGE_RENDER_STATUS_SCRIPT)).not.toThrow();
    expect(IMAGE_RENDER_STATUS_SCRIPT).toContain(IMAGE_RENDER_STATUS_MESSAGE_TYPE);
    expect(IMAGE_RENDER_STATUS_SCRIPT).toContain("img.complete && img.naturalWidth > 0");
  });
});

describe("IMAGE_RENDER_STATUS_SCRIPT at runtime", () => {
  interface FakeImg {
    tagName: string;
    complete: boolean;
    naturalWidth: number;
    attrs: Record<string, string>;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { height: number };
  }
  const img = (attrs: Record<string, string>, loaded: boolean, height: number): FakeImg => ({
    tagName: "IMG",
    complete: loaded,
    naturalWidth: loaded ? 800 : 0,
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ height }),
  });

  function run(images: FakeImg[]) {
    const posted: string[] = [];
    const timers: (() => void)[] = [];
    const root = { querySelectorAll: () => images };
    const observers: { callback: () => void; options: { attributeFilter?: string[] } }[] = [];
    class MutationObserver {
      constructor(private readonly callback: () => void) {}
      observe(_target: unknown, options: { attributeFilter?: string[] }) {
        observers.push({ callback: this.callback, options });
      }
    }
    const window: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: (data: string) => posted.push(data) },
      addEventListener: () => undefined,
      MutationObserver,
    };
    const document = {
      body: root,
      querySelector: () => root,
      addEventListener: () => undefined,
    };
    const setTimeout = (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    };
    const inject = () =>
      new Function(
        "window",
        "document",
        "setTimeout",
        "MutationObserver",
        IMAGE_RENDER_STATUS_SCRIPT,
      )(window, document, setTimeout, MutationObserver);
    const flush = () => {
      while (timers.length) timers.shift()?.();
    };
    return { posted, inject, flush, observers };
  }

  it("reports each image's state, named by alt text or by the path in its src", () => {
    const harness = run([
      img(
        {
          alt: "photo.jpg",
          src: "file:///docs/attachment-cache/u/n/photo.jpg#drafto-attachment=u%2Fn%2Fphoto.jpg",
        },
        true,
        240,
      ),
      img({ src: "file:///c/x.png#drafto-attachment=u%2Fn%2Forig%20name.png" }, false, 16),
      img({ src: "https://signed.example/u/n/remote.webp?token=t" }, true, 120),
    ]);
    harness.inject();
    harness.flush();
    expect(harness.posted).toHaveLength(1);
    expect(parseImageRenderStatus(harness.posted[0])).toEqual([
      { name: "photo.jpg", rendered: true, height: 240, local: true },
      { name: "orig name.png", rendered: false, height: 16, local: true },
      { name: "remote.webp", rendered: true, height: 120, local: false },
    ]);
  });

  it("re-posts an unchanged report when injected again, and only then", () => {
    const harness = run([img({ alt: "a.jpg", src: "file:///a.jpg" }, true, 100)]);
    harness.inject();
    harness.flush();
    harness.flush();
    expect(harness.posted).toHaveLength(1);
    harness.inject();
    harness.flush();
    expect(harness.posted).toHaveLength(2);
  });

  it("reports again when only an image's alt text changes", () => {
    const photo = img({ alt: "before.jpg", src: "file:///a.jpg" }, true, 100);
    const harness = run([photo]);
    harness.inject();
    harness.flush();
    expect(harness.observers).toHaveLength(1);
    expect(harness.observers[0].options.attributeFilter).toEqual(
      expect.arrayContaining(["src", "alt"]),
    );

    photo.attrs.alt = "after.jpg";
    harness.observers[0].callback();
    harness.flush();
    expect(harness.posted).toHaveLength(2);
    expect(parseImageRenderStatus(harness.posted[1])?.[0].name).toBe("after.jpg");
  });
});
