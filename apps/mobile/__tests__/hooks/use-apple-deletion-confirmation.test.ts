import { Platform } from "react-native";
import { renderHook } from "@testing-library/react-native";

import { useAppleDeletionConfirmation } from "@/hooks/use-apple-deletion-confirmation";

let mockUser: unknown = null;
jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: mockUser }),
}));

const APPLE_USER = {
  id: "user-1",
  app_metadata: { providers: ["apple"] },
  identities: [{ id: "apple-sub", user_id: "user-1", identity_id: "i1", provider: "apple" }],
};
const EMAIL_USER = {
  id: "user-1",
  app_metadata: { providers: ["email"] },
  identities: [{ id: "user-1", user_id: "user-1", identity_id: "i1", provider: "email" }],
};

describe("useAppleDeletionConfirmation", () => {
  let platformOs: jest.ReplaceProperty<typeof Platform.OS>;

  beforeEach(() => {
    platformOs = jest.replaceProperty(Platform, "OS", "ios");
  });

  afterEach(() => {
    platformOs.restore();
  });

  it("is true for a signed-in Apple user on iOS", () => {
    mockUser = APPLE_USER;
    expect(renderHook(() => useAppleDeletionConfirmation()).result.current).toBe(true);
  });

  it("is false for a user without Apple, or with no user", () => {
    mockUser = EMAIL_USER;
    expect(renderHook(() => useAppleDeletionConfirmation()).result.current).toBe(false);
    mockUser = null;
    expect(renderHook(() => useAppleDeletionConfirmation()).result.current).toBe(false);
  });

  it("is false on Android", () => {
    platformOs.replaceValue("android");
    mockUser = APPLE_USER;
    expect(renderHook(() => useAppleDeletionConfirmation()).result.current).toBe(false);
  });
});
