import AsyncStorage from "@react-native-async-storage/async-storage";

import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";

const USER_ID = "user-123";

describe("approval-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getCachedApproval", () => {
    it("returns null when no cached value exists", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const result = await getCachedApproval(USER_ID);
      expect(result).toBeNull();
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(`drafto_approval_status_${USER_ID}`);
    });

    it("returns true when cached value is 'true'", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue("true");
      const result = await getCachedApproval(USER_ID);
      expect(result).toBe(true);
    });

    it("returns false when cached value is 'false'", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue("false");
      const result = await getCachedApproval(USER_ID);
      expect(result).toBe(false);
    });
  });

  describe("setCachedApproval", () => {
    it("stores 'true' for approved, scoped by userId", async () => {
      await setCachedApproval(USER_ID, true);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        `drafto_approval_status_${USER_ID}`,
        "true",
      );
    });

    it("stores 'false' for not approved", async () => {
      await setCachedApproval(USER_ID, false);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        `drafto_approval_status_${USER_ID}`,
        "false",
      );
    });
  });

  describe("clearCachedApproval", () => {
    it("removes the cached value for the given userId", async () => {
      await clearCachedApproval(USER_ID);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(`drafto_approval_status_${USER_ID}`);
    });
  });
});
