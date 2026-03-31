const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const defaultConfig = getDefaultConfig(projectRoot);

const config = {
  watchFolders: [
    path.resolve(monorepoRoot, "packages", "shared"),
    path.resolve(monorepoRoot, "node_modules"),
  ],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(monorepoRoot, "node_modules"),
    ],
    extraNodeModules: {
      "react-native": path.resolve(monorepoRoot, "node_modules/react-native-macos"),
    },
    unstable_enableSymlinks: true,
  },
};

module.exports = mergeConfig(defaultConfig, config);
