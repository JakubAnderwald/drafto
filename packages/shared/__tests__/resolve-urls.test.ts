import { describe, expect, it, vi } from "vitest";
import {
  resolveBlockNoteImageUrls,
  resolveTipTapImageUrls,
  migrateSignedUrlsToAttachmentUrls,
} from "../src/editor/resolve-urls";
import type { BlockNoteBlock, TipTapDoc } from "../src/editor/types";

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

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/img.jpg");
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

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/report.pdf");
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

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/report.pdf");
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

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/img.jpg");
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

    expect(resolver).toHaveBeenCalledWith("user-1/note-1/report.pdf");
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
