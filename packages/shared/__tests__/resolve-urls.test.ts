import { describe, expect, it, vi } from "vitest";
import {
  resolveBlockNoteImageUrls,
  resolveTipTapImageUrls,
  migrateSignedUrlsToAttachmentUrls,
  withResolveTimeout,
  hasTipTapAttachmentRefs,
} from "../src/editor/resolve-urls";
import type { BlockNoteBlock, TipTapDoc } from "../src/editor/types";
import { toLocalAttachmentSrc } from "../src/editor/attachment-url";

describe("resolveBlockNoteImageUrls", () => {
  it("resolves attachment:// URLs via resolver", async () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "attachment://user-1/note-1/img.jpg" },
        children: [],
      },
    ];

    const resolver = vi.fn().mockResolvedValue("https://signed.url/img.jpg");
    const result = await resolveBlockNoteImageUrls(blocks, resolver);

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/img.jpg", "image");
    expect(result[0].props?.url).toBe("https://signed.url/img.jpg");
  });

  it("does not mutate input blocks", async () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "attachment://user-1/note-1/img.jpg" },
        children: [],
      },
    ];

    const resolver = vi.fn().mockResolvedValue("https://signed.url/img.jpg");
    await resolveBlockNoteImageUrls(blocks, resolver);

    expect(blocks[0].props?.url).toBe("attachment://user-1/note-1/img.jpg");
  });

  it("passes through blocks with no attachment:// URLs", async () => {
    const blocks: BlockNoteBlock[] = [
      { type: "paragraph", content: [{ type: "text", text: "hello" }], children: [] },
    ];

    const resolver = vi.fn();
    const result = await resolveBlockNoteImageUrls(blocks, resolver);

    expect(resolver).not.toHaveBeenCalled();
    expect(result).toBe(blocks); // same reference — no copy needed
  });

  it("resolves URLs in nested children", async () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [],
        children: [
          {
            type: "image",
            props: { url: "attachment://user-1/note-1/nested.jpg" },
            children: [],
          },
        ],
      },
    ];

    const resolver = vi.fn().mockResolvedValue("https://signed.url/nested.jpg");
    const result = await resolveBlockNoteImageUrls(blocks, resolver);

    expect(result[0].children?.[0].props?.url).toBe("https://signed.url/nested.jpg");
  });

  it("deduplicates resolver calls for same URL", async () => {
    const blocks: BlockNoteBlock[] = [
      { type: "image", props: { url: "attachment://path/a.jpg" }, children: [] },
      { type: "image", props: { url: "attachment://path/a.jpg" }, children: [] },
    ];

    const resolver = vi.fn().mockResolvedValue("https://signed.url/a.jpg");
    await resolveBlockNoteImageUrls(blocks, resolver);

    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("resolves attachment:// URLs on file blocks", async () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "file",
        props: { url: "attachment://user-1/note-1/report.pdf", name: "report.pdf" },
        children: [],
      },
    ];

    const resolver = vi.fn().mockResolvedValue("https://signed.url/report.pdf");
    const result = await resolveBlockNoteImageUrls(blocks, resolver);

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/report.pdf", "link");
    expect(result[0].props?.url).toBe("https://signed.url/report.pdf");
    expect(result[0].props?.name).toBe("report.pdf");
  });

  it("resolves attachment:// hrefs on inline link content", async () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            text: "report.pdf",
            href: "attachment://user-1/note-1/report.pdf",
            content: [{ type: "text", text: "report.pdf", styles: {} }],
          },
        ],
        children: [],
      },
    ];

    const resolver = vi.fn().mockResolvedValue("https://signed.url/report.pdf");
    const result = await resolveBlockNoteImageUrls(blocks, resolver);

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/report.pdf", "link");
    expect((result[0].content as { type: string; href?: string }[])[0].href).toBe(
      "https://signed.url/report.pdf",
    );
  });
});

describe("resolveTipTapImageUrls", () => {
  it("resolves attachment:// URLs in TipTap doc", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "attachment://user-1/note-1/img.jpg" },
        },
      ],
    };

    const resolver = vi.fn().mockResolvedValue("https://signed.url/img.jpg");
    const result = await resolveTipTapImageUrls(doc, resolver);

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/img.jpg", "image");
    expect(result.content[0].attrs?.src).toBe("https://signed.url/img.jpg");
  });

  it("does not mutate input doc", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "attachment://user-1/note-1/img.jpg" },
        },
      ],
    };

    const resolver = vi.fn().mockResolvedValue("https://signed.url/img.jpg");
    await resolveTipTapImageUrls(doc, resolver);

    expect(doc.content[0].attrs?.src).toBe("attachment://user-1/note-1/img.jpg");
  });

  it("passes through doc with no attachment:// URLs", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    };

    const resolver = vi.fn();
    const result = await resolveTipTapImageUrls(doc, resolver);

    expect(resolver).not.toHaveBeenCalled();
    expect(result).toBe(doc);
  });

  it("resolves attachment:// hrefs on link marks inside paragraphs", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "report.pdf",
              marks: [{ type: "link", attrs: { href: "attachment://user-1/note-1/report.pdf" } }],
            },
          ],
        },
      ],
    };

    const resolver = vi.fn().mockResolvedValue("https://signed.url/report.pdf");
    const result = await resolveTipTapImageUrls(doc, resolver);

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/report.pdf", "link");
    const text = result.content[0].content![0];
    expect(text.marks?.[0].attrs?.href).toBe("https://signed.url/report.pdf");
  });
});

describe("migrateSignedUrlsToAttachmentUrls", () => {
  it("converts Supabase signed URLs to attachment:// URLs", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: {
          url: "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/img.jpg?token=xyz",
        },
        children: [],
      },
    ];

    const result = migrateSignedUrlsToAttachmentUrls(blocks);

    expect(result[0].props?.url).toBe("attachment://user-1/note-1/img.jpg");
  });

  it("does not modify attachment:// URLs", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "attachment://user-1/note-1/img.jpg" },
        children: [],
      },
    ];

    const result = migrateSignedUrlsToAttachmentUrls(blocks);

    expect(result[0].props?.url).toBe("attachment://user-1/note-1/img.jpg");
  });

  it("does not modify external URLs", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: { url: "https://example.com/image.jpg" },
        children: [],
      },
    ];

    const result = migrateSignedUrlsToAttachmentUrls(blocks);

    expect(result[0].props?.url).toBe("https://example.com/image.jpg");
  });

  it("does not mutate input blocks", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "image",
        props: {
          url: "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/img.jpg?token=xyz",
        },
        children: [],
      },
    ];

    migrateSignedUrlsToAttachmentUrls(blocks);

    expect(blocks[0].props?.url).toContain("storage/v1/object/sign");
  });

  it("migrates signed URLs on file blocks", () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "file",
        props: {
          url: "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/report.pdf?token=xyz",
          name: "report.pdf",
        },
        children: [],
      },
    ];

    const result = migrateSignedUrlsToAttachmentUrls(blocks);

    expect(result[0].props?.url).toBe("attachment://user-1/note-1/report.pdf");
  });

  it("handles mixed content with images and text", () => {
    const blocks: BlockNoteBlock[] = [
      { type: "paragraph", content: [{ type: "text", text: "hello" }], children: [] },
      {
        type: "image",
        props: {
          url: "https://abc.supabase.co/storage/v1/object/sign/attachments/user-1/note-1/img.jpg?token=xyz",
        },
        children: [],
      },
      { type: "paragraph", content: [{ type: "text", text: "world" }], children: [] },
    ];

    const result = migrateSignedUrlsToAttachmentUrls(blocks);

    expect(result[0].type).toBe("paragraph");
    expect(result[1].props?.url).toBe("attachment://user-1/note-1/img.jpg");
    expect(result[2].type).toBe("paragraph");
  });
});

describe("attachment reference kinds", () => {
  it("tells the resolver whether a path is an image src or a link", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "attachment://u/n/pic.jpg" } },
        { type: "file", attrs: { src: "attachment://u/n/file.bin" } },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "doc",
              marks: [{ type: "link", attrs: { href: "attachment://u/n/doc.pdf" } }],
            },
          ],
        },
      ],
    };
    const resolver = vi.fn(async (filePath: string) => `resolved:${filePath}`);
    await resolveTipTapImageUrls(doc, resolver);
    expect(resolver.mock.calls).toEqual(
      expect.arrayContaining([
        ["u/n/pic.jpg", "image"],
        ["u/n/file.bin", "link"],
        ["u/n/doc.pdf", "link"],
      ]),
    );
  });

  it("resolves a path used as both an image and a link once per kind, so the link stays openable", async () => {
    const blocks: BlockNoteBlock[] = [
      {
        type: "paragraph",
        content: [
          {
            type: "link",
            href: "attachment://u/n/pic.jpg",
            content: [{ type: "text", text: "x" }],
          },
        ],
        children: [],
      },
      { type: "image", props: { url: "attachment://u/n/pic.jpg" }, children: [] },
      { type: "image", props: { url: "attachment://u/n/pic.jpg" }, children: [] },
    ];
    const local = toLocalAttachmentSrc("file:///c/pic.jpg", "u/n/pic.jpg");
    const resolver = vi.fn(async (_filePath: string, kind: string) =>
      kind === "image" ? local : "https://signed/pic.jpg",
    );
    const result = await resolveBlockNoteImageUrls(blocks, resolver);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledWith("u/n/pic.jpg", "image");
    expect(resolver).toHaveBeenCalledWith("u/n/pic.jpg", "link");
    expect((result[0].content as { href?: string }[])[0].href).toBe("https://signed/pic.jpg");
    expect(result[1].props?.url).toBe(local);
    expect(result[2].props?.url).toBe(local);
  });

  it("gives a TipTap link mark to an image the link's URL, and the image node its local src", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "attachment://u/n/pic.jpg" } },
        { type: "file", attrs: { src: "attachment://u/n/pic.jpg" } },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "pic",
              marks: [{ type: "link", attrs: { href: "attachment://u/n/pic.jpg" } }],
            },
          ],
        },
      ],
    };
    const local = toLocalAttachmentSrc("file:///c/pic.jpg", "u/n/pic.jpg");
    const resolver = vi.fn(async (_filePath: string, kind: string) =>
      kind === "image" ? local : "https://signed/pic.jpg",
    );
    const result = await resolveTipTapImageUrls(doc, resolver);
    expect(result.content[0].attrs?.src).toBe(local);
    expect(result.content[1].attrs?.src).toBe("https://signed/pic.jpg");
    expect(result.content[2].content?.[0].marks?.[0].attrs?.href).toBe("https://signed/pic.jpg");
  });

  it("leaves the link unresolved when only its link resolve fails (offline)", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "attachment://u/n/pic.jpg" } },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "pic",
              marks: [{ type: "link", attrs: { href: "attachment://u/n/pic.jpg" } }],
            },
          ],
        },
      ],
    };
    const local = toLocalAttachmentSrc("file:///c/pic.jpg", "u/n/pic.jpg");
    const resolver = vi.fn(async (_filePath: string, kind: string) => {
      if (kind === "link") throw new Error("offline");
      return local;
    });
    const result = await resolveTipTapImageUrls(doc, resolver);
    expect(result.content[0].attrs?.src).toBe(local);
    expect(result.content[1].content?.[0].marks?.[0].attrs?.href).toBe("attachment://u/n/pic.jpg");
  });

  it("leaves a src that fails to resolve (offline) as attachment:// and resolves the rest", async () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "attachment://u/n/missing.jpg" } },
        { type: "image", attrs: { src: "attachment://u/n/cached.jpg" } },
      ],
    };
    const resolver = vi.fn(async (filePath: string) => {
      if (filePath.endsWith("missing.jpg")) throw new Error("offline");
      return toLocalAttachmentSrc("file:///c/cached.jpg", filePath);
    });
    const result = await resolveTipTapImageUrls(doc, resolver);
    expect(result.content[0].attrs?.src).toBe("attachment://u/n/missing.jpg");
    expect(result.content[1].attrs?.src).toBe(
      "file:///c/cached.jpg#drafto-attachment=u%2Fn%2Fcached.jpg",
    );
  });
});

describe("migrateSignedUrlsToAttachmentUrls with device-local srcs (ADR-0086)", () => {
  const local = (filePath: string) =>
    toLocalAttachmentSrc("file:///data/user/0/eu.drafto.mobile/files/attachment-cache/x", filePath);

  it("maps a local src on image and file blocks, nested children and inline links back to attachment://", () => {
    const blocks: BlockNoteBlock[] = [
      { type: "image", props: { url: local("u/n/a b.jpg") }, children: [] },
      { type: "file", props: { url: local("u/n/r.pdf"), name: "r.pdf" }, children: [] },
      {
        type: "bulletListItem",
        content: [
          {
            type: "link",
            href: local("u/n/l.pdf"),
            content: [{ type: "text", text: "l" }],
          },
        ],
        children: [{ type: "image", props: { url: local("u/n/child.png") }, children: [] }],
      },
    ];
    const result = migrateSignedUrlsToAttachmentUrls(blocks);
    expect(result[0].props?.url).toBe("attachment://u/n/a b.jpg");
    expect(result[1].props?.url).toBe("attachment://u/n/r.pdf");
    const link = (result[2].content as { href?: string }[])[0];
    expect(link.href).toBe("attachment://u/n/l.pdf");
    expect(result[2].children?.[0].props?.url).toBe("attachment://u/n/child.png");
    const saved = JSON.stringify(result);
    expect(saved).not.toContain("file://");
    expect(saved).not.toContain("#drafto-attachment=");
  });

  it("leaves an unrelated file:// URL and https URLs alone", () => {
    const blocks: BlockNoteBlock[] = [
      { type: "image", props: { url: "file:///tmp/other.jpg" }, children: [] },
      { type: "image", props: { url: "https://example.com/a.jpg" }, children: [] },
    ];
    const result = migrateSignedUrlsToAttachmentUrls(blocks);
    expect(result[0].props?.url).toBe("file:///tmp/other.jpg");
    expect(result[1].props?.url).toBe("https://example.com/a.jpg");
  });
});

describe("withResolveTimeout", () => {
  const doc: TipTapDoc = {
    type: "doc",
    content: [
      { type: "image", attrs: { src: "attachment://u/n/cached.jpg" } },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "report",
            marks: [{ type: "link", attrs: { href: "attachment://u/n/report.pdf" } }],
          },
        ],
      },
    ],
  };

  it("leaves only the reference that hangs unresolved", async () => {
    vi.useFakeTimers();
    try {
      const resolver = vi.fn((filePath: string) =>
        filePath.endsWith(".pdf")
          ? new Promise<string>(() => undefined)
          : Promise.resolve(`file:///cache/${filePath}`),
      );
      const pending = resolveTipTapImageUrls(doc, withResolveTimeout(resolver, 8000));
      await vi.advanceTimersByTimeAsync(8000);
      const result = await pending;

      expect(result.content[0].attrs?.src).toBe("file:///cache/u/n/cached.jpg");
      expect(result.content[1].content?.[0].marks?.[0].attrs?.href).toBe(
        "attachment://u/n/report.pdf",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the reference kind through, and a rejection leaves that reference alone", async () => {
    const resolver = vi.fn(async (filePath: string) => {
      if (filePath.endsWith(".pdf")) throw new Error("offline");
      return `file:///cache/${filePath}`;
    });
    const result = await resolveTipTapImageUrls(doc, withResolveTimeout(resolver, 8000));
    expect(resolver).toHaveBeenCalledWith("u/n/cached.jpg", "image");
    expect(resolver).toHaveBeenCalledWith("u/n/report.pdf", "link");
    expect(result.content[0].attrs?.src).toBe("file:///cache/u/n/cached.jpg");
    expect(result.content[1].content?.[0].marks?.[0].attrs?.href).toBe(
      "attachment://u/n/report.pdf",
    );
  });
});

describe("PrimeTestLab 11035 S-04 hasTipTapAttachmentRefs", () => {
  const paragraphWithLink = (href: string): TipTapDoc => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "report.pdf", marks: [{ type: "link", attrs: { href } }] }],
      },
    ],
  });

  it("is true for a note with only a file link", () => {
    expect(hasTipTapAttachmentRefs(paragraphWithLink("attachment://u/n/report.pdf"))).toBe(true);
  });

  it("is true for an attachment image", () => {
    expect(
      hasTipTapAttachmentRefs({
        type: "doc",
        content: [{ type: "image", attrs: { src: "attachment://u/n/a.png" } }],
      }),
    ).toBe(true);
  });

  it("is false for ordinary links and an empty note", () => {
    expect(hasTipTapAttachmentRefs(paragraphWithLink("https://example.com"))).toBe(false);
    expect(hasTipTapAttachmentRefs({ type: "doc", content: [] })).toBe(false);
  });
});
