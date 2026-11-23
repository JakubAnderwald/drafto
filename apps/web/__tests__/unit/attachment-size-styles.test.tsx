import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AttachmentSizeStyles } from "@/components/editor/attachment-size-styles";

describe("PrimeTestLab 11035 S-04 AttachmentSizeStyles", () => {
  it("writes each file block's size, matched on its stored URL", () => {
    render(
      <AttachmentSizeStyles
        attachments={[
          { filePath: "u/n/report.pdf", fileSize: 1.2 * 1024 * 1024, mimeType: "application/pdf" },
        ]}
      />,
    );

    expect(screen.getByTestId("attachment-size-styles").textContent).toBe(
      '.bn-block-content[data-content-type="file"][data-url="attachment://u/n/report.pdf"]' +
        ' .bn-file-name-with-icon::after { content: "1.2 MB"; }',
    );
  });

  it("renders nothing when no file has a size", () => {
    const { container } = render(
      <AttachmentSizeStyles
        attachments={[{ filePath: "u/n/a.png", fileSize: 10, mimeType: "image/png" }]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
