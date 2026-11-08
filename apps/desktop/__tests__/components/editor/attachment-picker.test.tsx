import { Alert } from "react-native";
import { DEFAULT_STORAGE_QUOTA_BYTES, storageFullMessage } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../../helpers/test-utils";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { resetStorageFullAlert, STORAGE_FULL_ALERT_TITLE } from "@/lib/storage-full-alert";

const mockPickImage = jest.fn();
const mockQueueAttachment = jest.fn();
const mockFetchStorageUsage = jest.fn();
jest.mock("@/lib/data", () => ({
  pickImage: () => mockPickImage(),
  pickDocument: jest.fn(),
  queueAttachment: (...args: unknown[]) => mockQueueAttachment(...args),
  fetchStorageUsage: () => mockFetchStorageUsage(),
}));

jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

const mockSync = jest.fn();
jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({ sync: mockSync }),
}));

let mockIsConnected = true;
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ isConnected: mockIsConnected }),
}));

const QUOTA = DEFAULT_STORAGE_QUOTA_BYTES;
const FILE = {
  uri: "file:///photo.jpg",
  path: "/photo.jpg",
  fileName: "photo.jpg",
  mimeType: "image/jpeg",
  fileSize: 2048,
};

function makeAttachment(overrides: Record<string, unknown> = {}) {
  return { id: "att-1", isStorageFull: false, uploadError: null, ...overrides };
}

describe("AttachmentPicker storage quota (issue #794)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStorageFullAlert();
    mockIsConnected = true;
    mockPickImage.mockResolvedValue(FILE);
    mockSync.mockResolvedValue(undefined);
    mockFetchStorageUsage.mockResolvedValue({ usedBytes: 0, quotaBytes: QUOTA });
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("refuses a file that can't fit before saving or queueing it", async () => {
    const usage = { usedBytes: QUOTA - 1024, quotaBytes: QUOTA };
    mockFetchStorageUsage.mockResolvedValue(usage);
    const onAttachmentReady = jest.fn();
    const utils = render(
      <AttachmentPicker noteId="note-1" onAttachmentReady={onAttachmentReady} />,
    );

    fireEvent.press(utils.getByLabelText("Attach image"));

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        STORAGE_FULL_ALERT_TITLE,
        storageFullMessage(usage.usedBytes, usage.quotaBytes),
      ),
    );
    expect(mockQueueAttachment).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(onAttachmentReady).not.toHaveBeenCalled();
  });

  it("queues and uploads a file that fits", async () => {
    const attachment = makeAttachment();
    mockQueueAttachment.mockResolvedValue(attachment);
    const onAttachmentReady = jest.fn();
    const utils = render(
      <AttachmentPicker noteId="note-1" onAttachmentReady={onAttachmentReady} />,
    );

    fireEvent.press(utils.getByLabelText("Attach image"));

    await waitFor(() => expect(onAttachmentReady).toHaveBeenCalledWith(attachment));
    expect(mockQueueAttachment).toHaveBeenCalledWith("user-1", "note-1", FILE);
    expect(mockSync).toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("queues without a pre-check when the usage is unknown", async () => {
    mockFetchStorageUsage.mockResolvedValue(null);
    mockQueueAttachment.mockResolvedValue(makeAttachment());
    const onAttachmentReady = jest.fn();
    const utils = render(
      <AttachmentPicker noteId="note-1" onAttachmentReady={onAttachmentReady} />,
    );

    fireEvent.press(utils.getByLabelText("Attach image"));

    await waitFor(() => expect(onAttachmentReady).toHaveBeenCalled());
  });

  it("queues offline without reading the usage", async () => {
    mockIsConnected = false;
    mockQueueAttachment.mockResolvedValue(makeAttachment());
    const onAttachmentReady = jest.fn();
    const utils = render(
      <AttachmentPicker noteId="note-1" onAttachmentReady={onAttachmentReady} />,
    );

    fireEvent.press(utils.getByLabelText("Attach image"));

    await waitFor(() => expect(onAttachmentReady).toHaveBeenCalled());
    expect(mockFetchStorageUsage).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("alerts, and doesn't insert the attachment, when its upload is refused for the quota", async () => {
    const message = storageFullMessage(QUOTA, QUOTA);
    const attachment = makeAttachment();
    mockQueueAttachment.mockResolvedValue(attachment);
    mockSync.mockImplementation(async () => {
      Object.assign(attachment, { isStorageFull: true, uploadError: message });
    });
    const onAttachmentReady = jest.fn();
    const utils = render(
      <AttachmentPicker noteId="note-1" onAttachmentReady={onAttachmentReady} />,
    );

    fireEvent.press(utils.getByLabelText("Attach image"));

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(STORAGE_FULL_ALERT_TITLE, message),
    );
    expect(onAttachmentReady).not.toHaveBeenCalled();
  });
});
