import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { resolveBlockNoteImageUrls, type BlockNoteBlock } from "@drafto/shared";
import { AttachmentSizeStyles } from "@/components/editor/attachment-size-styles";

const SUPABASE_URL = "https://x.supabase.co/storage/v1";

/**
 * The signer GET /api/notes/:id uses, as supabase-js builds its result:
 * `encodeURI` of the storage URL, the signed path and its token.
 */
async function signLikeSupabase(filePath: string): Promise<string> {
  return encodeURI(`${SUPABASE_URL}/object/sign/attachments/${filePath}?token=abc.def`);
}

/** A file block's `data-url` as the web editor gets it for a saved note. */
async function loadedFileBlockUrl(filePath: string): Promise<string> {
  const blocks: BlockNoteBlock[] = [
    {
      id: "b1",
      type: "file",
      props: { url: `attachment://${filePath}`, name: "file" },
      content: [],
      children: [],
    },
  ];
  const [resolved] = await resolveBlockNoteImageUrls(blocks, signLikeSupabase);
  return String(resolved!.props!.url);
}

/** BlockNote's file block DOM, reduced to what the size rules select on. */
function renderFileBlock(url: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "bn-block-content";
  block.setAttribute("data-content-type", "file");
  block.setAttribute("data-url", url);
  const name = document.createElement("div");
  name.className = "bn-file-name-with-icon";
  block.appendChild(name);
  document.body.appendChild(block);
  return name;
}

/** The size label the injected stylesheet gives `element`, or null. */
function sizeLabelFor(element: HTMLElement): string | null {
  const style = screen.getByTestId("attachment-size-styles") as HTMLStyleElement;
  let label: string | null = null;
  for (const rule of Array.from(style.sheet!.cssRules) as CSSStyleRule[]) {
    // jsdom can't match a pseudo-element; the rule targets the name's ::after.
    if (element.matches(rule.selectorText.replace(/::after/g, ""))) {
      label = rule.style.getPropertyValue("content");
    }
  }
  return label;
}

describe("PrimeTestLab 11035 S-04 AttachmentSizeStyles", () => {
  it("writes each file block's size, matched on the key's unique suffix", () => {
    render(
      <AttachmentSizeStyles
        attachments={[
          {
            filePath: "u/n/report-1700000000000-0a1b2c3d.pdf",
            fileSize: 1.2 * 1024 * 1024,
            mimeType: "application/pdf",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("attachment-size-styles").textContent).toBe(
      '.bn-block-content[data-content-type="file"][data-url*="-1700000000000-0a1b2c3d"]' +
        ' .bn-file-name-with-icon::after { content: "1.2 MB"; }',
    );
  });

  it("labels a saved file block whose URL the note API resolved to a signed URL", async () => {
    const path = "u/n/Q3 raport łódź-1700000000000-0a1b2c3d.pdf";
    const oldPath = "u/n/old report.pdf";
    const url = await loadedFileBlockUrl(path);
    const oldUrl = await loadedFileBlockUrl(oldPath);
    expect(url).toContain("/storage/v1/object/sign/attachments/");
    expect(url).not.toContain("attachment://");

    render(
      <AttachmentSizeStyles
        attachments={[
          { filePath: path, fileSize: 1.2 * 1024 * 1024, mimeType: "application/pdf" },
          { filePath: oldPath, fileSize: 812 * 1024, mimeType: "application/pdf" },
        ]}
      />,
    );

    expect(sizeLabelFor(renderFileBlock(url))).toBe('"1.2 MB"');
    expect(sizeLabelFor(renderFileBlock(oldUrl))).toBe('"812 KB"');
    expect(sizeLabelFor(renderFileBlock(`attachment://${path}`))).toBe('"1.2 MB"');
    expect(
      sizeLabelFor(
        renderFileBlock(await loadedFileBlockUrl("u/n/other-1700000000001-ffffffff.pdf")),
      ),
    ).toBeNull();
  });

  it("renders nothing when no file has a size", () => {
    const { container } = render(
      <AttachmentSizeStyles
        attachments={[{ filePath: "u/n/a.pdf", fileSize: null, mimeType: "application/pdf" }]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
