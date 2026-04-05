import AsyncStorage from "@react-native-async-storage/async-storage";

const APPROVAL_KEY_PREFIX = "drafto_approval_status_";

function keyFor(userId: string): string {
  return `${APPROVAL_KEY_PREFIX}${userId}`;
}

export async function getCachedApproval(userId: string): Promise<boolean | null> {
  const value = await AsyncStorage.getItem(keyFor(userId));
  if (value === null) return null;
  return value === "true";
}

export async function setCachedApproval(userId: string, approved: boolean): Promise<void> {
  await AsyncStorage.setItem(keyFor(userId), String(approved));
}

export async function clearCachedApproval(userId: string): Promise<void> {
  await AsyncStorage.removeItem(keyFor(userId));
}
