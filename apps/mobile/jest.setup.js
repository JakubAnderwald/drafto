// Mock expo-secure-store
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock expo-haptics
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: "Light", Medium: "Medium", Heavy: "Heavy" },
  NotificationFeedbackType: {
    Success: "Success",
    Warning: "Warning",
    Error: "Error",
  },
}));

// Mock expo-router
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
  })),
  useLocalSearchParams: jest.fn(() => ({})),
  Link: ({ children, ...props }) => {
    const { Text } = require("react-native");
    return <Text {...props}>{children}</Text>;
  },
  Stack: {
    Screen: () => null,
  },
}));

// Mock @react-native-community/netinfo
jest.mock("@react-native-community/netinfo", () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  }),
}));

// Mock react-native-safe-area-context
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: jest.fn(() => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  })),
  SafeAreaProvider: ({ children }) => children,
}));

// Mock @10play/tentap-editor
jest.mock("@10play/tentap-editor", () => ({
  useEditorBridge: jest.fn(() => ({
    getJSON: jest.fn().mockResolvedValue({ type: "doc", content: [] }),
    setContent: jest.fn(),
  })),
  TenTapStartKit: [],
  RichText: () => null,
  Toolbar: () => null,
}));

// Mock @expo/vector-icons
jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return {
    Ionicons: ({ name, ...props }) => <Text {...props}>{name}</Text>,
  };
});

// Mock @react-native-google-signin/google-signin
// Mirrors the real v16 contract: `signIn()` resolves a tagged response (`success` / `cancelled`)
// instead of throwing on cancel, and `statusCodes` carries the values the Android native module
// exports from `getTypedExportedConstants()` — not the constant names.
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn().mockResolvedValue(true),
    signIn: jest.fn().mockResolvedValue({ type: "success", data: { idToken: "mock-id-token" } }),
    signOut: jest.fn().mockResolvedValue(null),
  },
  statusCodes: {
    SIGN_IN_CANCELLED: "12501",
    IN_PROGRESS: "ASYNC_OP_IN_PROGRESS",
    PLAY_SERVICES_NOT_AVAILABLE: "PLAY_SERVICES_NOT_AVAILABLE",
    SIGN_IN_REQUIRED: "4",
    NULL_PRESENTER: "NULL_PRESENTER",
  },
  isErrorWithCode: (error) =>
    (error instanceof Error || (typeof error === "object" && error !== null)) && "code" in error,
}));

// Mock expo-apple-authentication
jest.mock("expo-apple-authentication", () => ({
  signInAsync: jest.fn().mockResolvedValue({
    identityToken: "mock-apple-token",
    fullName: { givenName: "Test", familyName: "User" },
    email: "test@example.com",
  }),
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  AppleAuthenticationScope: {
    FULL_NAME: 0,
    EMAIL: 1,
  },
}));

// Mock expo-web-browser
jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: jest.fn().mockResolvedValue({ type: "cancel" }),
  maybeCompleteAuthSession: jest.fn(),
}));

// Mock react-native-svg
jest.mock("react-native-svg", () => {
  const { View, Text } = require("react-native");
  return {
    __esModule: true,
    default: View,
    Svg: View,
    Path: View,
    Circle: View,
    Rect: View,
    G: View,
    Text: Text,
  };
});

// Silence console.error for act warnings in tests
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("inside a test was not wrapped in act")) {
    return;
  }
  originalError.call(console, ...args);
};
