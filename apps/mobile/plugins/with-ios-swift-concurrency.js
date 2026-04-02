const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Expo config plugin that suppresses Swift 6 strict concurrency errors
 * for all pod targets during `expo prebuild`.
 *
 * Expo SDK 55's expo-modules-core uses @MainActor as a retroactive
 * conformance attribute (Swift 6 syntax) but isn't fully compatible
 * with Swift 6 strict concurrency enforcement. We pass
 * -Xfrontend -strict-concurrency=minimal to downgrade actor isolation
 * and sendability violations to warnings while keeping Swift 6 syntax.
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
      if (contents.includes("strict-concurrency=minimal")) {
        return config;
      }

      // Insert concurrency fix before the closing `end` of the post_install block
      const postInstallPatch = `
    # Suppress Swift 6 strict concurrency errors for pods (Expo SDK 55 compat)
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        existing = build_config.build_settings['OTHER_SWIFT_FLAGS'] || '$(inherited)'
        unless existing.include?('-strict-concurrency=minimal')
          build_config.build_settings['OTHER_SWIFT_FLAGS'] = existing + ' -Xfrontend -strict-concurrency=minimal'
        end
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
