import React from "react";
import { ActivityIndicator, Alert, StyleSheet } from "react-native";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_STORAGE_QUOTA_BYTES, storageFullMessage } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { semanticDark, semanticLight } from "@/theme/tokens";
import type { Attachment } from "@/db";

const mockPickImage = jest.fn();
const mockPickDocument = jest.fn();
const mockQueueAttachment = jest.fn();
const mockUploadAttachment = jest.fn();
const mockFetchStorageUsage = jest.fn();
const mockDiscardRefusedAttachment = jest.fn();

jest.mock("@/lib/data", () => ({
  discardRefusedAttachment: (attachment: unknown) => mockDiscardRefusedAttachment(attachment),
  fetchStorageUsage: () => mockFetchStorageUsage(),
  pickImage: () => mockPickImage(),
  pickDocument: () => mockPickDocument(),
  queueAttachment: (...args: unknown[]) => mockQueueAttachment(...args),
  uploadAttachment: (attachment: unknown) => mockUploadAttachment(attachment),
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

const mockShowToast = jest.fn();
jest.mock("@/components/toast", () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

const FILE = {
  uri: "file:///photo.jpg",
  fileName: "photo.jpg",
  mimeType: "image/jpeg",
  fileSize: 10,
};
const ATTACHMENT = { id: "att-1", fileName: "photo.jpg" } as Attachment;

describe("AttachmentPicker", () => {
  let calls: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    calls = [];
    mockIsConnected = true;
    mockPickImage.mockResolvedValue(FILE);
    mockPickDocument.mockResolvedValue(FILE);
    mockFetchStorageUsage.mockResolvedValue(null);
    mockDiscardRefusedAttachment.mockResolvedValue(undefined);
    mockQueueAttachment.mockImplementation(async () => {
      calls.push("queue");
      return ATTACHMENT;
    });
    mockUploadAttachment.mockImplementation(async () => {
      calls.push("upload");
      return true;
    });
    mockSync.mockImplementation(() => {
      calls.push("sync");
      // A sync that never settles must not hold up the picker.
      return new Promise(() => {});
    });
  });

  function pickWith(label: "Attach image" | "Attach file", onReady?: jest.Mock) {
    const utils = render(<AttachmentPicker noteId="note-1" onAttachmentReady={onReady} />);
    fireEvent.press(utils.getByLabelText(label));
    return utils;
  }

  it("uploads the file itself, then inserts it, then syncs without waiting", async () => {
    const onReady = jest.fn(async () => {
      calls.push("insert");
    });

    const { findByText } = pickWith("Attach image", onReady);

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    expect(mockQueueAttachment).toHaveBeenCalledWith("user-1", "note-1", FILE);
    expect(mockUploadAttachment).toHaveBeenCalledWith(ATTACHMENT);
    expect(onReady).toHaveBeenCalledWith(ATTACHMENT);
    expect(calls).toEqual(["queue", "upload", "insert", "sync"]);
    expect(mockShowToast).toHaveBeenCalledWith("Attachment uploaded", "success");
    expect(mockDiscardRefusedAttachment).not.toHaveBeenCalled();
    // Back to the buttons although the sync is still running.
    expect(await findByText("Image")).toBeTruthy();
  });

  it("waits for the image to be inserted before settling", async () => {
    let finishInsert!: () => void;
    const onReady = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInsert = resolve;
        }),
    );

    const { findByText } = pickWith("Attach image", onReady);

    await waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(await findByText("Saving...")).toBeTruthy();
    expect(mockShowToast).not.toHaveBeenCalled();

    finishInsert();
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith("Attachment uploaded", "success"),
    );
  });

  it("says the upload failed, not that it succeeded, when the upload fails", async () => {
    mockUploadAttachment.mockResolvedValue(false);
    const onReady = jest.fn();

    pickWith("Attach file", onReady);

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        "Upload failed — will retry automatically",
        "warning",
      ),
    );
    expect(mockShowToast).not.toHaveBeenCalledWith("Attachment uploaded", "success");
    // The attachment is still inserted (it is saved locally) and retried by sync.
    expect(onReady).toHaveBeenCalledWith(ATTACHMENT);
    expect(mockSync).toHaveBeenCalled();
  });

  describe("storage quota (issue #794)", () => {
    const FULL = {
      usedBytes: DEFAULT_STORAGE_QUOTA_BYTES - FILE.fileSize + 1,
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
    };

    it("says storage is full, without saving the file, when it would go over the quota", async () => {
      mockFetchStorageUsage.mockResolvedValue(FULL);
      const onReady = jest.fn();

      const { findByText } = pickWith("Attach image", onReady);

      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          storageFullMessage(FULL.usedBytes, FULL.quotaBytes),
          "warning",
        ),
      );
      expect(mockQueueAttachment).not.toHaveBeenCalled();
      expect(mockUploadAttachment).not.toHaveBeenCalled();
      expect(onReady).not.toHaveBeenCalled();
      expect(await findByText("Image")).toBeTruthy();
    });

    it("attaches a file that lands exactly on the quota", async () => {
      mockFetchStorageUsage.mockResolvedValue({
        usedBytes: DEFAULT_STORAGE_QUOTA_BYTES - FILE.fileSize,
        quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      });

      pickWith("Attach image");

      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith("Attachment uploaded", "success"),
      );
      expect(mockQueueAttachment).toHaveBeenCalled();
    });

    it("says storage is full, not that it will retry, when the server refuses the upload", async () => {
      const message = storageFullMessage(FULL.usedBytes, FULL.quotaBytes);
      const refused = {
        ...ATTACHMENT,
        isStorageFull: true,
        uploadError: message,
      } as unknown as Attachment;
      mockQueueAttachment.mockResolvedValue(refused);
      mockUploadAttachment.mockResolvedValue(false);
      // Discarding the record may clear what it reads; the toast keeps the message.
      mockDiscardRefusedAttachment.mockImplementation(async (attachment: Attachment) => {
        calls.push("discard");
        Object.assign(attachment, { uploadError: null });
      });
      const onReady = jest.fn();

      pickWith("Attach file", onReady);

      await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(message, "warning"));
      // Nothing references it, so its record and local copy go before the sync runs.
      expect(mockDiscardRefusedAttachment).toHaveBeenCalledWith(refused);
      expect(calls).toEqual(["discard", "sync"]);
      expect(mockShowToast).not.toHaveBeenCalledWith(
        "Upload failed — will retry automatically",
        "warning",
      );
      // Never reaches the server, so the note must not reference it.
      expect(onReady).not.toHaveBeenCalled();
    });

    it("skips the check offline", async () => {
      mockIsConnected = false;

      pickWith("Attach image");

      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith(
          "Attachment saved — will upload when online",
          "info",
        ),
      );
      expect(mockFetchStorageUsage).not.toHaveBeenCalled();
    });
  });

  it("saves offline without trying to upload", async () => {
    mockIsConnected = false;
    const onReady = jest.fn();

    pickWith("Attach image", onReady);

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        "Attachment saved — will upload when online",
        "info",
      ),
    );
    expect(mockUploadAttachment).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledWith(ATTACHMENT);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockPickImage.mockResolvedValue(null);

    pickWith("Attach image");

    await waitFor(() => expect(mockPickImage).toHaveBeenCalled());
    expect(mockQueueAttachment).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("shows a permission error as an alert", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockPickImage.mockRejectedValue(new Error("Permission to access photos was denied"));

    pickWith("Attach image");

    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        "Permission Required",
        "Permission to access photos was denied",
      ),
    );
    alert.mockRestore();
  });

  it("shows any other failure as a toast", async () => {
    mockQueueAttachment.mockRejectedValue(new Error("File size exceeds 50MB limit"));

    pickWith("Attach file");

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith("File size exceeds 50MB limit", "warning"),
    );
    expect(mockUploadAttachment).not.toHaveBeenCalled();
  });

  describe("theme", () => {
    const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

    afterEach(() => {
      mockSecureStore.getItemAsync.mockResolvedValue(null);
    });

    function buttonColors(utils: ReturnType<typeof render>) {
      return {
        background: StyleSheet.flatten(utils.getByLabelText("Attach image").props.style)
          .backgroundColor,
        text: StyleSheet.flatten(utils.getByText("Image").props.style).color,
        icon: utils.getByText("image-outline").props.color,
      };
    }

    it("tints the buttons with the subtle accent tokens in light mode", () => {
      mockSecureStore.getItemAsync.mockResolvedValue(null);
      const utils = render(<AttachmentPicker noteId="note-1" />);

      expect(buttonColors(utils)).toEqual({
        background: semanticLight.accentSubtleBg,
        text: semanticLight.accentSubtleText,
        icon: semanticLight.accentSubtleText,
      });
    });

    it("uses the dark subtle accent in dark mode, not the light lavender pill", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("dark");
      const utils = render(<AttachmentPicker noteId="note-1" />);

      await waitFor(() =>
        expect(buttonColors(utils)).toEqual({
          background: semanticDark.accentSubtleBg,
          text: semanticDark.accentSubtleText,
          icon: semanticDark.accentSubtleText,
        }),
      );
      expect(semanticDark.accentSubtleBg).not.toBe(semanticLight.accentSubtleBg);
    });

    it("colours the saving spinner with the dark subtle accent in dark mode", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("dark");
      const utils = render(
        <AttachmentPicker noteId="note-1" onAttachmentReady={() => new Promise(() => {})} />,
      );
      await waitFor(() =>
        expect(
          StyleSheet.flatten(utils.getByLabelText("Attach image").props.style).backgroundColor,
        ).toBe(semanticDark.accentSubtleBg),
      );

      fireEvent.press(utils.getByLabelText("Attach image"));

      expect(await utils.findByText("Saving...")).toBeTruthy();
      expect(utils.UNSAFE_getByType(ActivityIndicator).props.color).toBe(
        semanticDark.accentSubtleText,
      );
    });
  });
});
