// uploadAttachment: the editor's direct upload of a freshly picked file, and how
// it shares work with the sync's processPendingUploads.

const mockUpload = jest.fn();
const mockUpsert = jest.fn();
const mockQuery = jest.fn();
const mockFileBytes = jest.fn();

jest.mock("expo-file-system", () => ({
  File: jest.fn().mockImplementation((uri: string) => ({
    uri,
    exists: true,
    size: 1024,
    bytes: () => mockFileBytes(),
    delete: jest.fn(),
  })),
  Directory: jest.fn(),
  Paths: { document: "/mock/documents" },
}));

jest.mock("@drafto/shared", () => ({
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  BUCKET_NAME: "attachments",
  FILE_TOO_LARGE_MESSAGE: "File size exceeds 50MB limit",
}));

jest.mock("@/db", () => ({
  database: {
    write: (fn: () => Promise<unknown>) => fn(),
    get: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
  },
}));

jest.mock("@/lib/supabase", () => ({
  supabase: {
    storage: { from: () => ({ upload: (...args: unknown[]) => mockUpload(...args) }) },
    from: () => ({ upsert: (...args: unknown[]) => mockUpsert(...args) }),
  },
}));

jest.mock("@/lib/generate-id", () => ({ generateId: () => "mock-id" }));

import { uploadAttachment, processPendingUploads } from "@/lib/data/attachment-queue";
import type { Attachment } from "@/db";

type Fields = { uploadStatus: string; uploadError: string | null; localUri: string | null };

function makeAttachment(id = "att-1") {
  const fields: Fields = {
    uploadStatus: "pending",
    uploadError: null,
    localUri: `file:///local/${id}.jpg`,
  };
  const attachment = {
    id,
    remoteId: id,
    noteId: "note-1",
    userId: "user-1",
    fileName: `${id}.jpg`,
    filePath: `user-1/note-1/${id}.jpg`,
    fileSize: 1024,
    mimeType: "image/jpeg",
    get localUri() {
      return fields.localUri;
    },
    get uploadStatus() {
      return fields.uploadStatus;
    },
    update: jest.fn(async (apply: (record: Fields) => void) => apply(fields)),
  };
  return { attachment: attachment as unknown as Attachment, fields };
}

describe("uploadAttachment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    mockUpload.mockResolvedValue({ error: null });
    mockUpsert.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uploads the file and its row, marks it uploaded and reports success", async () => {
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(true);

    expect(mockUpload).toHaveBeenCalledWith("user-1/note-1/att-1.jpg", expect.any(Uint8Array), {
      contentType: "image/jpeg",
      upsert: false,
    });
    expect(mockUpsert).toHaveBeenCalled();
    expect(fields).toEqual({ uploadStatus: "uploaded", uploadError: null, localUri: null });
  });

  it("records a failure on the row for the next sync to retry, and reports it without throwing", async () => {
    mockUpload.mockResolvedValue({ error: { message: "Network request failed" } });
    const { attachment, fields } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(false);

    expect(fields.uploadStatus).toBe("failed");
    expect(fields.uploadError).toBe("Upload failed: Network request failed");
    expect(fields.localUri).toBe("file:///local/att-1.jpg");
  });

  it("shares one upload between overlapping calls for the same attachment", async () => {
    let finishUpload!: (value: { error: null }) => void;
    mockUpload.mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    const { attachment } = makeAttachment();

    const first = uploadAttachment(attachment);
    const second = uploadAttachment(attachment);
    finishUpload({ error: null });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("lets a sync that starts mid-upload wait for that upload instead of repeating it", async () => {
    let finishUpload!: (value: { error: null }) => void;
    mockUpload.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    const { attachment } = makeAttachment();
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });

    const direct = uploadAttachment(attachment);
    const sync = processPendingUploads();
    // Let the sync fetch the queue and reach the in-flight upload.
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    finishUpload({ error: null });

    await expect(direct).resolves.toBe(true);
    await expect(sync).resolves.toEqual({ uploaded: 1, failed: 0 });
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("leaves alone an attachment a direct upload finished after the sync fetched its queue", async () => {
    const { attachment, fields } = makeAttachment();
    // The sync fetched the queue while the attachment was still pending...
    mockQuery.mockReturnValue({ fetch: jest.fn().mockResolvedValue([attachment]) });
    // ...and the direct upload completed before the sync's loop reached it.
    await expect(uploadAttachment(attachment)).resolves.toBe(true);

    await expect(processPendingUploads()).resolves.toEqual({ uploaded: 1, failed: 0 });

    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(fields.uploadStatus).toBe("uploaded");
  });

  it("uploads again on a later call once the first attempt has finished", async () => {
    mockUpload.mockResolvedValueOnce({ error: { message: "timeout" } });
    const { attachment } = makeAttachment();

    await expect(uploadAttachment(attachment)).resolves.toBe(false);
    await expect(uploadAttachment(attachment)).resolves.toBe(true);

    expect(mockUpload).toHaveBeenCalledTimes(2);
  });
});
