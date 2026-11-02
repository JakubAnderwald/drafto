import type { ConfigContext, ExpoConfig } from "expo/config";

import appConfig from "../../app.config";

// iOS permission purpose strings are generated from these plugin options, not from
// a checked-in Info.plist: `apps/mobile/ios` is untracked and every release lane
// runs `expo prebuild --clean`, so the plist is regenerated on every build and a
// hand edit would vanish. App Review guideline 5.1.1(ii) rejects vague strings and
// strings for permissions the app never uses, which is exactly what Expo's
// defaults are ("Allow $(PRODUCT_NAME) to access your camera"). Pin them here so a
// future edit to the plugin list can't quietly reintroduce a rejection.
const PHOTOS_PERMISSION = "Drafto uses your photo library so you can attach images to your notes.";

// app.config.ts reads only `config` (spread) and `process.env`, so the remaining
// ConfigContext fields just have to be present and well-typed.
const config: ExpoConfig = appConfig({
  config: {},
  projectRoot: "apps/mobile",
  staticConfigPath: null,
  packageJsonPath: null,
} satisfies ConfigContext);

function pluginOptions(name: string): Record<string, unknown> {
  const entry = (config.plugins ?? []).find(
    (plugin): plugin is [string, Record<string, unknown>] =>
      Array.isArray(plugin) && plugin[0] === name && typeof plugin[1] === "object",
  );
  if (!entry) {
    throw new Error(`app.config.ts has no configured "${name}" plugin entry`);
  }
  return entry[1];
}

function hasBareEntry(name: string): boolean {
  return (config.plugins ?? []).includes(name);
}

describe("app.config.ts iOS permission purpose strings", () => {
  describe("expo-image-picker", () => {
    it("states the real reason Drafto reads the photo library", () => {
      expect(pluginOptions("expo-image-picker").photosPermission).toBe(PHOTOS_PERMISSION);
    });

    it("removes the camera and microphone permissions the app never asks for", () => {
      // The only picker call is ImagePicker.launchImageLibraryAsync in
      // src/lib/data/attachments.ts. `false` deletes NSCameraUsageDescription /
      // NSMicrophoneUsageDescription on iOS and blocks CAMERA / RECORD_AUDIO in
      // the Android manifest — both platforms, one flag.
      const options = pluginOptions("expo-image-picker");
      expect(options.cameraPermission).toBe(false);
      expect(options.microphonePermission).toBe(false);
    });

    it("is configured, never listed bare", () => {
      // A bare "expo-image-picker" string entry would restore Expo's generic
      // defaults for all three keys.
      expect(hasBareEntry("expo-image-picker")).toBe(false);
    });
  });

  describe("expo-secure-store", () => {
    it("removes the Face ID permission (no biometric-protected keychain items)", () => {
      // No SecureStore call passes `requireAuthentication`, so the Face ID prompt
      // can never appear and NSFaceIDUsageDescription would be a permission string
      // for an unused capability.
      expect(pluginOptions("expo-secure-store").faceIDPermission).toBe(false);
    });

    it("is configured, never listed bare", () => {
      expect(hasBareEntry("expo-secure-store")).toBe(false);
    });
  });

  it("declares exempt encryption so App Store Connect skips the questionnaire", () => {
    expect(config.ios?.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
  });
});
