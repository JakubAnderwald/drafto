import AsyncStorage from "@react-native-async-storage/async-storage";

const APPROVAL_KEY = "drafto_approval_status";

export async function getCachedApproval(): Promise<boolean | null> {
  const value = await AsyncStorage.getItem(APPROVAL_KEY);
  if (value === null) return null;
  return value === "true";
}

export async function setCachedApproval(approved: boolean): Promise<void> {
  await AsyncStorage.setItem(APPROVAL_KEY, String(approved));
}

export async function clearCachedApproval(): Promise<void> {
  await AsyncStorage.removeItem(APPROVAL_KEY);
}
