import * as Crypto from "expo-crypto";

export function generateId(): string {
  return Crypto.randomUUID();
}
