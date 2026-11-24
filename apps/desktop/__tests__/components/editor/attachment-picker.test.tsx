import { ActivityIndicator, Alert, StyleSheet } from "react-native";
import { DEFAULT_STORAGE_QUOTA_BYTES, storageFullMessage } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../../helpers/test-utils";
import { AttachmentPicker } from "@/components/editor/attachment-picker";
import { STORAGE_FULL_ALERT_TITLE } from "@/lib/storage-full-alert";
import { semanticDark, semanticLight } from "@/theme/tokens";

const mockPickImage = jest.fn();
const mockQueueAttachment = jest.fn();
const mockFetchStorageUsage = jest.fn();
const mockDiscardRefusedAttachment = jest.fn();
jest.mock("@/lib/data", () => ({
  pickImage: () => mockPickImage(),
  pickDocument: jest.fn(),
  queueAttachment: (...args: unknown[]) => mockQueueAttachment(...args),
  fetchStorageUsage: () => mockFetchStorageUsage(),
  discardRefusedAttachment: (attachment: unknown) => mockDiscardRefusedAttachment(attachment),
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

// jest.setup.js stubs the theme provider with a fixed light palette; this one serves the
// real tokens for either theme, so the tests can check what the buttons look like in dark mode.
let mockIsDark = false;
jest.mock("@/providers/theme-provider", () => {
  const { getSemanticColors } = jest.requireActual("@drafto/shared");
  return {
    ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
    useTheme: () => ({
      semantic: getSemanticColors(mockIsDark),
      isDark: mockIsDark,
      theme: mockIsDark ? "dark" : "light",
      setTheme: jest.fn(),
    }),
  };
});

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
    mockIsConnected = true;
    mockPickImage.mockResolvedValue(FILE);
    mockSync.mockResolvedValue(undefined);
    mockDiscardRefusedAttachment.mockResolvedValue(undefined);
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
    expect(mockDiscardRefusedAttachment).not.toHaveBeenCalled();
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

  it("doesn't insert the attachment, and leaves the alert to the provider, when its upload is refused for the quota", async () => {
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

    await waitFor(() => expect(mockSync).toHaveBeenCalled());
    // The buttons come back once the pick has finished.
    await waitFor(() => expect(utils.getByLabelText("Attach image")).toBeTruthy());
    expect(onAttachmentReady).not.toHaveBeenCalled();
    // Nothing references it, so its record and local copy go (the user has the original).
    expect(mockDiscardRefusedAttachment).toHaveBeenCalledWith(attachment);
    // DatabaseProvider alerts for the sync's refusals, so the picker adds no second one.
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

describe("AttachmentPicker theme", () => {
  afterEach(() => {
    mockIsDark = false;
  });

  function buttonColors(utils: ReturnType<typeof render>) {
    return {
      background: StyleSheet.flatten(utils.getByLabelText("Attach image").props.style)
        .backgroundColor,
      text: StyleSheet.flatten(utils.getByText("Image").props.style).color,
    };
  }

  it("tints the buttons with the subtle accent tokens in light mode", () => {
    mockIsDark = false;
    const utils = render(<AttachmentPicker noteId="note-1" />);

    expect(buttonColors(utils)).toEqual({
      background: semanticLight.accentSubtleBg,
      text: semanticLight.accentSubtleText,
    });
  });

  it("uses the dark subtle accent in dark mode, not the light lavender pill", () => {
    mockIsDark = true;
    const utils = render(<AttachmentPicker noteId="note-1" />);

    expect(buttonColors(utils)).toEqual({
      background: semanticDark.accentSubtleBg,
      text: semanticDark.accentSubtleText,
    });
    expect(semanticDark.accentSubtleBg).not.toBe(semanticLight.accentSubtleBg);
  });

  it("colours the saving spinner with the dark subtle accent in dark mode", async () => {
    mockIsDark = true;
    mockPickImage.mockResolvedValue(FILE);
    mockIsConnected = true;
    // Usage never arrives, so the picker stays on "Saving...".
    mockFetchStorageUsage.mockReturnValue(new Promise(() => {}));
    const utils = render(<AttachmentPicker noteId="note-1" />);

    fireEvent.press(utils.getByLabelText("Attach image"));

    expect(await utils.findByText("Saving...")).toBeTruthy();
    expect(utils.UNSAFE_getByType(ActivityIndicator).props.color).toBe(
      semanticDark.accentSubtleText,
    );
  });
});
