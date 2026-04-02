const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Expo config plugin that forces Swift 5 language mode for all pod targets
 * during `expo prebuild`.
 *
 * Xcode 16.2+ defaults to Swift 6 language mode, which treats concurrency
 * violations as errors. Expo SDK 55's expo-modules-core uses @MainActor
 * patterns that are incompatible with Swift 6 strict concurrency.
 * Forcing Swift 5 mode restores these as warnings/ignored.
 *
 * Remove this plugin after upgrading to Expo SDK 56+.
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

      // Insert Swift 5 enforcement before the closing `end` of the post_install block
      const postInstallPatch = `
    # Force Swift 5 mode for pods (Expo SDK 55 + Xcode 16.2+ compat)
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        build_config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
        build_config.build_settings['SWIFT_VERSION'] = '5.0'
        build_config.build_settings['OTHER_SWIFT_FLAGS'] = '$(inherited) -swift-version 5'
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
