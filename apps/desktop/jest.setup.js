// Set up React Native bridge config for native module resolution
// This prevents "Invariant Violation: __fbBatchedBridgeConfig is not set"
// when WatermelonDB tries to access NativeModules
globalThis.__fbBatchedBridgeConfig = {
  remoteModuleConfig: [],
  localModulesConfig: [],
};

// Mock WatermelonDB's native random ID generator
jest.mock("@nozbe/watermelondb/utils/common/randomId/randomId.native", () => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return {
    default: () => {
      let id = "";
      for (let i = 0; i < 16; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
      }
      return id;
    },
  };
});

// Mock react-native-keychain
jest.mock("react-native-keychain", () => ({
  setGenericPassword: jest.fn().mockResolvedValue(true),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
  ACCESSIBLE: { WHEN_UNLOCKED: "WHEN_UNLOCKED" },
}));

// Mock @react-native-community/netinfo
jest.mock("@react-native-community/netinfo", () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  }),
}));

// Mock @react-native-async-storage/async-storage
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
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

// Mock react-native-fs
jest.mock("react-native-fs", () => ({
  DocumentDirectoryPath: "/mock/documents",
  exists: jest.fn().mockResolvedValue(true),
  mkdir: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  readDir: jest.fn().mockResolvedValue([]),
}));

// Mock react-native-document-picker-macos
jest.mock("react-native-document-picker-macos", () => ({
  pick: jest.fn().mockResolvedValue([]),
}));

// Mock react-native-webview
jest.mock("react-native-webview", () => {
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: (props) => View(props),
    WebView: (props) => View(props),
  };
});

// Mock the theme provider — avoids the deep react-native native module chain
// (useColorScheme → Appearance → NativeEventEmitter → Platform → PlatformConstants TurboModule)
// that isn't available in Jest without a full RN test environment.
jest.mock("@/providers/theme-provider", () => {
  const React = require("react");
  return {
    ThemeProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    useTheme: () => ({
      semantic: {
        bg: "#ffffff",
        bgSecondary: "#f5f5f5",
        fg: "#1a1a1a",
        fgMuted: "#6b7280",
        fgSubtle: "#9ca3af",
        border: "#e5e7eb",
        borderStrong: "#d1d5db",
        primary: "#4f46e5",
        onPrimary: "#ffffff",
        errorBg: "#fef2f2",
        errorBorder: "#fecaca",
        errorText: "#dc2626",
        successBg: "#f0fdf4",
        successBorder: "#bbf7d0",
        successText: "#16a34a",
      },
      isDark: false,
      theme: "light",
      setTheme: jest.fn(),
    }),
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
