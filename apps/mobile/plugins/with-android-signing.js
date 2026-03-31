const { withAppBuildGradle } = require("expo/config-plugins");

/**
 * Expo config plugin that injects release signing configuration into
 * android/app/build.gradle during `expo prebuild`.
 *
 * Reads keystore location and passwords from environment variables:
 * - ANDROID_KEYSTORE_PATH (defaults to ~/drafto-secrets/drafto-release.keystore)
 * - ANDROID_KEYSTORE_PASSWORD
 * - ANDROID_KEY_PASSWORD
 * - ANDROID_KEY_ALIAS (defaults to "drafto")
 */
function withAndroidSigning(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    // Skip if release signing config is already present (idempotency)
    if (contents.includes("signingConfigs.release")) {
      return config;
    }

    const releaseSigningBlock = `
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH") ?: System.getProperty("user.home") + "/drafto-secrets/drafto-release.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "drafto"
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: ""
        }`;

    // Inject release block inside existing signingConfigs (after the debug block's closing brace)
    // Pattern: find the closing "}" of the debug block inside signingConfigs
    contents = contents.replace(
      /(signingConfigs\s*\{[^}]*debug\s*\{[^}]*\})/,
      `$1${releaseSigningBlock}`,
    );

    // Replace release buildType to use signingConfigs.release instead of signingConfigs.debug
    contents = contents.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
      "$1signingConfig signingConfigs.release",
    );

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withAndroidSigning;
