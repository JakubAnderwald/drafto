import * as SecureStore from "expo-secure-store";

const APPROVAL_KEY = "drafto_approval_status";

export async function getCachedApproval(): Promise<boolean | null> {
  const value = await SecureStore.getItemAsync(APPROVAL_KEY);
  if (value === null) return null;
  return value === "true";
}

export async function setCachedApproval(approved: boolean): Promise<void> {
  await SecureStore.setItemAsync(APPROVAL_KEY, String(approved));
}

export async function clearCachedApproval(): Promise<void> {
  await SecureStore.deleteItemAsync(APPROVAL_KEY);
}
