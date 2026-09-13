const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Expo config plugin: opt the Google Sign-In transitive pods into modular headers.
 *
 * `@react-native-google-signin/google-signin` pulls in `AppCheckCore` (a Swift pod)
 * which depends on `GoogleUtilities` and `RecaptchaInterop`. Those two do not define
 * Clang modules, so CocoaPods cannot integrate them into the Swift `AppCheckCore`
 * target as static libraries and `pod install` fails:
 *
 *   The Swift pod `AppCheckCore` depends upon `GoogleUtilities` and
 *   `RecaptchaInterop`, which do not define modules.
 *
 * Declaring those two with `:modular_headers => true` generates the module maps they
 * need, without flipping the whole project to `use_modular_headers!` (which would
 * force modular headers on every pod, including React Native's).
 *
 * The `ios/` project is regenerated on every `expo prebuild`, so this fix must live
 * as a config plugin rather than a hand edit to the generated Podfile.
 *
 * Remove if a future @react-native-google-signin / AppCheckCore release defines the
 * modules itself, or after adopting a setup that vendors these as frameworks.
 */
function withIosModularHeaders(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, "Podfile");
      if (!fs.existsSync(podfilePath)) {
        return config;
      }

      let contents = fs.readFileSync(podfilePath, "utf-8");

      // Check for the exact declarations we need — not any `:modular_headers => true`
      // entry — so an unrelated modular-headers pod can't make us skip the fix, and a
      // partially-patched Podfile still gets the missing pod(s) added.
      const requiredPods = [
        "pod 'GoogleUtilities', :modular_headers => true",
        "pod 'RecaptchaInterop', :modular_headers => true",
      ];
      const missingPods = requiredPods.filter((declaration) => !contents.includes(declaration));
      if (missingPods.length === 0) {
        return config; // already patched
      }

      const modularPods = [
        ...(missingPods.length === requiredPods.length
          ? ["  # Google Sign-In's AppCheckCore (Swift) requires these to expose Clang modules."]
          : []),
        ...missingPods.map((declaration) => `  ${declaration}`),
      ].join("\n");

      // Insert just after `use_expo_modules!` inside the app target.
      const anchor = /^(\s*use_expo_modules!.*)$/m;
      if (!anchor.test(contents)) {
        throw new Error(
          "with-ios-modular-headers: could not find the `use_expo_modules!` anchor in the Podfile",
        );
      }
      contents = contents.replace(anchor, `$1\n${modularPods}`);

      fs.writeFileSync(podfilePath, contents);
      return config;
    },
  ]);
}

module.exports = withIosModularHeaders;
