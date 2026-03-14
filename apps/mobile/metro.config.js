const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch only the packages Metro needs to resolve (not the entire monorepo)
config.watchFolders = [
  path.resolve(monorepoRoot, "packages", "shared"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Resolve modules from both the project and monorepo node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

module.exports = config;
