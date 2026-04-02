const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Expo config plugin that disables Swift strict concurrency checking
 * for all pod targets during `expo prebuild`.
 *
 * Expo SDK 55's expo-modules-core Swift code uses @MainActor patterns
 * that trigger errors with Xcode 16.2+ strict concurrency enforcement.
 * Setting SWIFT_STRICT_CONCURRENCY=minimal suppresses these errors
 * until Expo SDK 56+ adds proper concurrency annotations.
 */
function withIosSwiftConcurrency(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, "Podfile");

      if (!fs.existsSync(podfilePath)) {
        return config;
      }

      let contents = fs.readFileSync(podfilePath, "utf-8");

      // Skip if already patched
      if (contents.includes("SWIFT_STRICT_CONCURRENCY")) {
        return config;
      }

      // Insert concurrency fix before the closing `end` of the post_install block
      const postInstallPatch = `
    # Disable Swift strict concurrency for pods (Expo SDK 55 + Xcode 16.2+ compat)
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        build_config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
      end
    end
`;

      // Match the `end` that closes `post_install do |installer|` — it's followed by `\nend\n` (the target block end)
      contents = contents.replace(/(\n  end\nend\s*$)/, `\n${postInstallPatch}$1`);

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

module.exports = withIosSwiftConcurrency;
