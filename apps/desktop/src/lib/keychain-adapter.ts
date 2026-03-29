import * as Keychain from "react-native-keychain";

const SERVICE_NAME = "eu.drafto.desktop";

/**
 * Storage adapter for Supabase auth that uses macOS Keychain
 * via react-native-keychain (replaces expo-secure-store).
 */
export const keychainAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    const result = await Keychain.getGenericPassword({ service: `${SERVICE_NAME}.${key}` });
    if (result) {
      return result.password;
    }
    return null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await Keychain.setGenericPassword(key, value, {
      service: `${SERVICE_NAME}.${key}`,
    });
  },
  removeItem: async (key: string): Promise<void> => {
    await Keychain.resetGenericPassword({ service: `${SERVICE_NAME}.${key}` });
  },
};
