import * as SecureStore from "expo-secure-store";

import { getCachedApproval, setCachedApproval, clearCachedApproval } from "@/lib/approval-cache";

jest.mock("expo-secure-store");

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

const USER_ID = "user-123";

describe("approval-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getCachedApproval", () => {
    it("returns null when no cached value exists", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue(null);
      const result = await getCachedApproval(USER_ID);
      expect(result).toBeNull();
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith(
        `drafto_approval_status_${USER_ID}`,
      );
    });

    it("returns true when cached value is 'true'", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("true");
      const result = await getCachedApproval(USER_ID);
      expect(result).toBe(true);
    });

    it("returns false when cached value is 'false'", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("false");
      const result = await getCachedApproval(USER_ID);
      expect(result).toBe(false);
    });
  });

  describe("setCachedApproval", () => {
    it("stores 'true' for approved, scoped by userId", async () => {
      await setCachedApproval(USER_ID, true);
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        `drafto_approval_status_${USER_ID}`,
        "true",
      );
    });

    it("stores 'false' for not approved", async () => {
      await setCachedApproval(USER_ID, false);
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        `drafto_approval_status_${USER_ID}`,
        "false",
      );
    });
  });

  describe("clearCachedApproval", () => {
    it("removes the cached value for the given userId", async () => {
      await clearCachedApproval(USER_ID);
      expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(
        `drafto_approval_status_${USER_ID}`,
      );
    });
  });
});
