const path = require("path");

module.exports = {
  preset: "react-native",
  setupFiles: ["./jest.setup.js"],
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/__tests__/helpers/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // Force @testing-library/react-native to use the root react-native, not its nested copy
    "^react-native$": path.resolve(__dirname, "../../node_modules/react-native"),
    // Mock TurboModuleRegistry to provide stubs for all native TurboModules
    ".*/TurboModule/TurboModuleRegistry$": "<rootDir>/jest/mocks/TurboModuleRegistry.js",
  },
  transformIgnorePatterns: [
    "node_modules/(?!(" +
      "react-native|" +
      "@react-native|" +
      "react-native-macos|" +
      "@react-native-community|" +
      "@react-native-async-storage|" +
      "@react-navigation|" +
      "react-native-screens|" +
      "react-native-safe-area-context|" +
      "react-native-keychain|" +
      "react-native-fs|" +
      "react-native-webview|" +
      "react-native-document-picker-macos|" +
      "@10play/tentap-editor|" +
      "@nozbe/watermelondb|" +
      "@nozbe/with-observables|" +
      "@drafto/shared|" +
      "@testing-library" +
      ")/)",
  ],
};
