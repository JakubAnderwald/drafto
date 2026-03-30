import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { AttachmentList } from "@/components/editor/attachment-list";

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

const mockGetCachedSignedUrl = jest.fn();
const mockOpenAttachment = jest.fn();
const mockGetCachedSignedUrlSync = jest.fn();
const mockInvalidateCachedSignedUrl = jest.fn();
jest.mock("@/lib/data", () => ({
  deleteAttachment: jest.fn(),
  openAttachment: (...args: unknown[]) => mockOpenAttachment(...args),
  getCachedSignedUrl: (...args: unknown[]) => mockGetCachedSignedUrl(...args),
  getCachedSignedUrlSync: (...args: unknown[]) => mockGetCachedSignedUrlSync(...args),
  invalidateCachedSignedUrl: (...args: unknown[]) => mockInvalidateCachedSignedUrl(...args),
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
  mockGetCachedSignedUrl.mockResolvedValue("https://example.com/signed-url");
  mockGetCachedSignedUrlSync.mockReturnValue(null);
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
    mockGetCachedSignedUrl.mockRejectedValue(new Error("Network error"));

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

  it("allows opening image attachment when image preview fails to render", async () => {
    const attachments = [createMockAttachment()];
    const { getByLabelText, UNSAFE_getByType } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    // Wait for signed URL to load
    await waitFor(() => {
      expect(mockGetCachedSignedUrl).toHaveBeenCalled();
    });

    // Simulate image load error
    const { Image } = require("react-native");
    await waitFor(() => {
      const image = UNSAFE_getByType(Image);
      fireEvent(image, "error");
    });

    // The fallback should be tappable
    await waitFor(() => {
      const pressable = getByLabelText("Open photo.jpg");
      fireEvent.press(pressable);
    });

    await waitFor(() => {
      expect(mockOpenAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ signedUrl: "https://example.com/signed-url" }),
      );
    });
  });

  it("shows 'Tap to open' hint when image preview fails", async () => {
    const attachments = [createMockAttachment()];
    const { UNSAFE_getByType, getByText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    // Wait for signed URL to resolve and Image to appear
    const { Image } = require("react-native");
    await waitFor(() => {
      UNSAFE_getByType(Image);
    });

    // Simulate image load error outside waitFor to fire only once
    const image = UNSAFE_getByType(Image);
    fireEvent(image, "error");

    await waitFor(() => {
      expect(getByText("Tap to open")).toBeTruthy();
    });
  });

  it("retries URL fetch on press when in error state", async () => {
    mockGetCachedSignedUrl
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
      expect(mockGetCachedSignedUrl).toHaveBeenCalledTimes(2);
    });
  });

  it("preserves image via lastGoodUri when transitioning from pending to uploaded", async () => {
    const pending = createMockAttachment({
      uploadStatus: "pending",
      isPendingUpload: true,
      localUri: "file:///local/photo.jpg",
    });

    const { rerender, UNSAFE_getByType } = render(
      <AttachmentList attachments={[pending] as unknown as never[]} />,
    );

    // Image renders with localUri while pending
    const { Image } = require("react-native");
    await waitFor(() => {
      const image = UNSAFE_getByType(Image);
      expect(image.props.source.uri).toBe("file:///local/photo.jpg");
    });

    // Simulate upload completing: isPending becomes false, localUri is cleared
    const uploaded = createMockAttachment({
      uploadStatus: "uploaded",
      isPendingUpload: false,
      localUri: null,
    });

    rerender(<AttachmentList attachments={[uploaded] as unknown as never[]} />);

    // Image should still be visible (using lastGoodUri fallback) while signed URL loads
    await waitFor(() => {
      const image = UNSAFE_getByType(Image);
      expect(image.props.source.uri).toBeTruthy();
    });
  });

  it("uses cached signed URL to render immediately without async fetch", async () => {
    // Simulate cache hit via sync accessor
    mockGetCachedSignedUrlSync.mockReturnValue("https://example.com/cached-url");

    const attachments = [createMockAttachment()];
    const { UNSAFE_getByType } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    // Image should render immediately from cache without calling async getCachedSignedUrl
    const { Image } = require("react-native");
    await waitFor(() => {
      const image = UNSAFE_getByType(Image);
      expect(image.props.source.uri).toBe("https://example.com/cached-url");
    });

    // Async fetch should not be triggered since signedUrl was already set from cache
    expect(mockGetCachedSignedUrl).not.toHaveBeenCalled();
  });

  it("calls getCachedSignedUrl for uploaded attachments", async () => {
    const attachments = [createMockAttachment()];
    render(<AttachmentList attachments={attachments as unknown as never[]} />);

    await waitFor(() => {
      expect(mockGetCachedSignedUrl).toHaveBeenCalledWith("user-1/note-1/photo.jpg");
    });
  });

  it("invalidates cache on retry after URL error", async () => {
    mockGetCachedSignedUrl
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce("https://example.com/retry-url");

    const attachments = [
      createMockAttachment({ mimeType: "application/pdf", fileName: "doc.pdf" }),
    ];
    const { getByLabelText, getByText } = render(
      <AttachmentList attachments={attachments as unknown as never[]} />,
    );

    await waitFor(() => {
      expect(getByText("Tap to retry")).toBeTruthy();
    });

    fireEvent.press(getByLabelText("Open doc.pdf"));

    await waitFor(() => {
      expect(mockInvalidateCachedSignedUrl).toHaveBeenCalledWith("user-1/note-1/photo.jpg");
    });
  });
});
