import * as SecureStore from "expo-secure-store";

import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";

jest.mock("expo-secure-store");

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe("approval-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getCachedApproval", () => {
    it("returns null when no cached value exists", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue(null);
      const result = await getCachedApproval();
      expect(result).toBeNull();
    });

    it("returns true when cached value is 'true'", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("true");
      const result = await getCachedApproval();
      expect(result).toBe(true);
    });

    it("returns false when cached value is 'false'", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("false");
      const result = await getCachedApproval();
      expect(result).toBe(false);
    });
  });

  describe("setCachedApproval", () => {
    it("stores 'true' for approved", async () => {
      await setCachedApproval(true);
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("drafto_approval_status", "true");
    });

    it("stores 'false' for not approved", async () => {
      await setCachedApproval(false);
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("drafto_approval_status", "false");
    });
  });

  describe("clearCachedApproval", () => {
    it("removes the cached value", async () => {
      await clearCachedApproval();
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("drafto_approval_status");
    });
  });
});
