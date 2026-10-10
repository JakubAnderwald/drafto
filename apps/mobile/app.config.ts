import { ExpoConfig, ConfigContext } from "expo/config";
import pkg from "./package.json";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Drafto",
  slug: "drafto",
  owner: "jakubanderwald",
  version: pkg.version,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  scheme: "drafto",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#3525CD",
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "eu.drafto.mobile",
    associatedDomains: ["applinks:drafto.eu", "applinks:www.drafto.eu"],
    usesAppleSignIn: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#3525CD",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    package: "eu.drafto.mobile",
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: "drafto.eu", pathPrefix: "/notebooks" },
          { scheme: "https", host: "drafto.eu", pathPrefix: "/notes" },
          {
            scheme: "https",
            host: "www.drafto.eu",
            pathPrefix: "/notebooks",
          },
          { scheme: "https", host: "www.drafto.eu", pathPrefix: "/notes" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    // Web origin for server-side account operations (DELETE /api/account). The
    // apex host serves /api/* directly; a www redirect would drop the bearer token.
    apiUrl: process.env.EXPO_PUBLIC_API_URL || "https://drafto.eu",
    eas: {
      projectId: "6cf2a8f0-c2a6-410c-89dc-3e49aa4119a5",
    },
  },
  updates: {
    enabled: false,
  },
  // iOS permission purpose strings live here, NOT in a checked-in Info.plist:
  // apps/mobile/ios is untracked and every release lane runs
  // `expo prebuild --clean`, so a hand-edited plist would be erased. App Review
  // guideline 5.1.1(ii) rejects both vague strings and strings for permissions
  // the app never asks for, so each plugin below either states the real reason or
  // sets the key to `false` to delete it.
  plugins: [
    "expo-router",
    [
      "expo-secure-store",
      {
        // No SecureStore call passes `requireAuthentication`, so nothing in the
        // app is behind a biometric-protected keychain item and the Face ID
        // prompt can never appear. `false` deletes NSFaceIDUsageDescription.
        faceIDPermission: false,
      },
    ],
    [
      "expo-image-picker",
      {
        // The only picker call is ImagePicker.launchImageLibraryAsync in
        // src/lib/data/attachments.ts — the photo library, for note attachments.
        photosPermission: "Drafto uses your photo library so you can attach images to your notes.",
        // No camera and no audio recording anywhere in the app. `false` deletes
        // NSCameraUsageDescription / NSMicrophoneUsageDescription on iOS and
        // blocks CAMERA / RECORD_AUDIO in the Android manifest.
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    "expo-font",
    "expo-apple-authentication",
    [
      "@react-native-google-signin/google-signin",
      {
        iosUrlScheme: process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME,
      },
    ],
    "./plugins/with-android-optimizations",
    "./plugins/with-android-gradle-memory",
    "./plugins/with-android-signing",
    "./plugins/with-ios-swift-concurrency",
    "./plugins/with-ios-modular-headers",
    "./plugins/with-ios-pod-deployment-target",
    "./plugins/with-ios-scene-lifecycle",
  ],
});
