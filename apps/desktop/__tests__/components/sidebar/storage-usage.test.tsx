import { StyleSheet } from "react-native";
import { DEFAULT_CONTENT_QUOTA_BYTES, DEFAULT_STORAGE_QUOTA_BYTES } from "@drafto/shared";

import { render } from "../../helpers/test-utils";
import { StorageUsageMeter } from "@/components/sidebar/storage-usage";
import { colors } from "@/theme/tokens";

let mockUsage: { usedBytes: number; quotaBytes: number | null } | null = null;
let mockContentUsage: { usedBytes: number; quotaBytes: number | null } | null = null;
const mockRefresh = jest.fn().mockResolvedValue(undefined);
const mockRefreshContent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/hooks/use-storage-usage", () => ({
  useStorageUsage: () => ({ usage: mockUsage, loading: false, refresh: mockRefresh }),
  useContentUsage: () => ({
    usage: mockContentUsage,
    loading: false,
    refresh: mockRefreshContent,
  }),
}));

let mockIsSyncing = false;
jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({ isSyncing: mockIsSyncing }),
}));

const QUOTA = DEFAULT_STORAGE_QUOTA_BYTES;

function fillOf(utils: ReturnType<typeof render>) {
  return StyleSheet.flatten(utils.getByTestId("storage-usage-fill").props.style) as {
    width: string;
    backgroundColor: string;
  };
}

describe("StorageUsageMeter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsage = null;
    mockContentUsage = null;
    mockIsSyncing = false;
  });

  it("renders nothing until a reading arrives", () => {
    const utils = render(<StorageUsageMeter />);
    expect(utils.queryByTestId("storage-usage")).toBeNull();
  });

  it("fills with the primary color below the warning threshold", () => {
    mockUsage = { usedBytes: QUOTA / 4, quotaBytes: QUOTA };
    const utils = render(<StorageUsageMeter />);

    expect(utils.getByText("Storage: 12.5 MB of 50 MB used")).toBeTruthy();
    expect(fillOf(utils)).toMatchObject({ width: "25%", backgroundColor: colors.primary[600] });
    expect(utils.getByTestId("storage-usage-bar").props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 25,
    });
  });

  it("turns warning above 90% of the quota", () => {
    mockUsage = { usedBytes: Math.round(QUOTA * 0.95), quotaBytes: QUOTA };
    const utils = render(<StorageUsageMeter />);
    expect(fillOf(utils).backgroundColor).toBe(colors.warning);
  });

  it("turns danger at the quota and never overflows the bar", () => {
    mockUsage = { usedBytes: QUOTA * 2, quotaBytes: QUOTA };
    const utils = render(<StorageUsageMeter />);
    expect(fillOf(utils)).toMatchObject({ width: "100%", backgroundColor: colors.error });
  });

  it("shows no bar for an unlimited quota", () => {
    mockUsage = { usedBytes: QUOTA, quotaBytes: null };
    const utils = render(<StorageUsageMeter />);
    expect(utils.getByText("Storage: 50 MB used")).toBeTruthy();
    expect(utils.queryByTestId("storage-usage-bar")).toBeNull();
  });

  it("re-reads the usage once a sync finishes, not when one starts", () => {
    mockUsage = { usedBytes: 0, quotaBytes: QUOTA };
    const utils = render(<StorageUsageMeter />);

    mockIsSyncing = true;
    utils.rerender(<StorageUsageMeter />);
    expect(mockRefresh).not.toHaveBeenCalled();

    mockIsSyncing = false;
    utils.rerender(<StorageUsageMeter />);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefreshContent).toHaveBeenCalledTimes(1);
  });

  describe("note content line (ADR 0090)", () => {
    const CONTENT_QUOTA = DEFAULT_CONTENT_QUOTA_BYTES;

    it("shows the notes line below the storage line", () => {
      mockUsage = { usedBytes: 0, quotaBytes: QUOTA };
      mockContentUsage = { usedBytes: 1024 * 1024, quotaBytes: CONTENT_QUOTA };
      const utils = render(<StorageUsageMeter />);

      expect(utils.getByTestId("content-usage")).toHaveTextContent("Notes: 1 MB of 25 MB used");
    });

    it("turns the notes line danger at its quota", () => {
      mockUsage = { usedBytes: 0, quotaBytes: QUOTA };
      mockContentUsage = { usedBytes: CONTENT_QUOTA, quotaBytes: CONTENT_QUOTA };
      const utils = render(<StorageUsageMeter />);

      const plain = render(<StorageUsageMeter />);
      mockContentUsage = { usedBytes: 0, quotaBytes: CONTENT_QUOTA };
      plain.rerender(<StorageUsageMeter />);

      const color = (el: ReturnType<typeof utils.getByTestId>) =>
        (StyleSheet.flatten(el.props.style) as { color: string }).color;
      expect(color(utils.getByTestId("content-usage"))).not.toBe(
        color(plain.getByTestId("content-usage")),
      );
    });

    it("shows the notes line alone when storage can't be read", () => {
      mockContentUsage = { usedBytes: 0, quotaBytes: null };
      const utils = render(<StorageUsageMeter />);

      expect(utils.getByTestId("content-usage")).toHaveTextContent("Notes: 0 MB used");
      expect(utils.queryByTestId("storage-usage-bar")).toBeNull();
    });

    it("shows nothing when neither can be read", () => {
      const utils = render(<StorageUsageMeter />);
      expect(utils.queryByTestId("content-usage")).toBeNull();
    });
  });
});
