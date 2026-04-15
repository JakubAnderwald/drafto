module.exports = {
  preset: "react-native",
  setupFilesAfterEnv: ["./jest.setup.js"],
  testPathIgnorePatterns: ["/node_modules/", "/__tests__/helpers/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
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
  coverageThreshold: {
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
};
