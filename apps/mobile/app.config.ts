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
    eas: {
      projectId: "6cf2a8f0-c2a6-410c-89dc-3e49aa4119a5",
    },
  },
  updates: {
    enabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-font",
    "expo-apple-authentication",
    [
      "@react-native-google-signin/google-signin",
      {
        iosUrlScheme: process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME,
      },
    ],
    "./plugins/with-android-optimizations",
    "./plugins/with-android-signing",
    "./plugins/with-ios-swift-concurrency",
  ],
});
