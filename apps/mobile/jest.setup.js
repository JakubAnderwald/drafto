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

// Silence console.error for act warnings in tests
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("inside a test was not wrapped in act")) {
    return;
  }
  originalError.call(console, ...args);
};
