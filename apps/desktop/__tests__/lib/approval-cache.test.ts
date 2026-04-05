import AsyncStorage from "@react-native-async-storage/async-storage";

import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";

describe("approval-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getCachedApproval", () => {
    it("returns null when no cached value exists", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const result = await getCachedApproval();
      expect(result).toBeNull();
    });

    it("returns true when cached value is 'true'", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue("true");
      const result = await getCachedApproval();
      expect(result).toBe(true);
    });

    it("returns false when cached value is 'false'", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue("false");
      const result = await getCachedApproval();
      expect(result).toBe(false);
    });
  });

  describe("setCachedApproval", () => {
    it("stores 'true' for approved", async () => {
      await setCachedApproval(true);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith("drafto_approval_status", "true");
    });

    it("stores 'false' for not approved", async () => {
      await setCachedApproval(false);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith("drafto_approval_status", "false");
    });
  });

  describe("clearCachedApproval", () => {
    it("removes the cached value", async () => {
      await clearCachedApproval();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith("drafto_approval_status");
    });
  });
});
