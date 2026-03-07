module.exports = {
  preset: "jest-expo",
  setupFiles: ["./jest.setup.js"],
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/__tests__/helpers/"],
};
