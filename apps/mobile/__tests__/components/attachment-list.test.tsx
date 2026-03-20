import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { AttachmentList } from "../../src/components/editor/attachment-list";

const mockSync = jest.fn().mockResolvedValue(undefined);
const mockDatabaseWrite = jest.fn((fn: () => Promise<void>) => fn());

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({
    database: { write: mockDatabaseWrite },
    sync: mockSync,
    isSyncing: false,
  }),
}));

const mockShowToast = jest.fn();

jest.mock("@/components/toast", () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const mockGetSignedUrl = jest.fn();
const mockOpenAttachment = jest.fn();
jest.mock("@/lib/data", () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
  deleteAttachment: jest.fn(),
  openAttachment: (...args: unknown[]) => mockOpenAttachment(...args),
}));

// Mock shape matching WatermelonDB Attachment model — cast needed because
// AttachmentList expects full model instances, not plain objects.
interface MockAttachment {
  id: string;
  remoteId: string;
  noteId: string;
  userId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  createdAt: Date;
  localUri: string | null;
  uploadStatus: "pending" | "uploaded";
  isPendingUpload: boolean;
  markAsDeleted: jest.Mock;
}

function createMockAttachment(overrides: Partial<MockAttachment> = {}): MockAttachment {
  return {
    id: "att-1",
    remoteId: "remote-att-1",
    noteId: "note-1",
    userId: "user-1",
    fileName: "photo.jpg",
    filePath: "user-1/note-1/photo.jpg",
    fileSize: 1024,
    mimeType: "image/jpeg",
    createdAt: new Date(),
    localUri: null,
    uploadStatus: "uploaded" as const,
    isPendingUpload: false,
    markAsDeleted: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSignedUrl.mockResolvedValue("https://example.com/signed-url");
  mockOpenAttachment.mockResolvedValue({ status: "opened" });
});

describe("AttachmentList", () => {
  it("renders nothing when attachments array is empty", () => {
    const { queryByText } = render(<AttachmentList attachments={[] as unknown as never[]} />);
    expect(queryByText("Attachments")).toBeNull();
  });

  it("renders attachment items with section title", () => {
    const attachments = [createMockAttachment()];
    const { getByText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );
    expect(getByText("Attachments")).toBeTruthy();
    expect(getByText("photo.jpg")).toBeTruthy();
  });

  it("shows pending badge for pending attachments", () => {
    const attachments = [
      createMockAttachment({
        uploadStatus: "pending",
        isPendingUpload: true,
        localUri: "file:///local/photo.jpg",
      }),
    ];
    const { getByText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );
    expect(getByText("Pending")).toBeTruthy();
  });

  it("shows toast when openAttachment returns unavailable", async () => {
    mockOpenAttachment.mockResolvedValue({
      status: "unavailable",
      reason: "Could not load attachment URL",
    });

    const attachments = [
      createMockAttachment({ mimeType: "application/pdf", fileName: "doc.pdf" }),
    ];
    const { getByLabelText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    // Wait for signed URL to load and component to re-render with enabled state
    await waitFor(() => {
      const el = getByLabelText("Open doc.pdf");
      expect(el.props.accessibilityState?.disabled).not.toBe(true);
    });

    await waitFor(() => {
      fireEvent.press(getByLabelText("Open doc.pdf"));
      expect(mockOpenAttachment).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("Could not load attachment URL", "warning");
    });
  });

  it("shows retry text when signed URL fetch fails for documents", async () => {
    mockGetSignedUrl.mockRejectedValue(new Error("Network error"));

    const attachments = [
      createMockAttachment({ mimeType: "application/pdf", fileName: "doc.pdf" }),
    ];
    const { getByText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    await waitFor(() => {
      expect(getByText("Tap to retry")).toBeTruthy();
    });
  });

  it("retries URL fetch on press when in error state", async () => {
    mockGetSignedUrl
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce("https://example.com/signed-url-retry");

    const attachments = [
      createMockAttachment({ mimeType: "application/pdf", fileName: "doc.pdf" }),
    ];
    const { getByLabelText, getByText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    // Wait for initial failure
    await waitFor(() => {
      expect(getByText("Tap to retry")).toBeTruthy();
    });

    // Press to retry
    fireEvent.press(getByLabelText("Open doc.pdf"));

    await waitFor(() => {
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(2);
    });
  });
});
