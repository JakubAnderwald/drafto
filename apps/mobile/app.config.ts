import { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Drafto",
  slug: "drafto",
  owner: "jakubanderwald",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  scheme: "drafto",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#4f46e5",
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: "eu.drafto.mobile",
    associatedDomains: ["applinks:drafto.eu", "applinks:www.drafto.eu"],
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#4f46e5",
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
    "./plugins/with-android-optimizations",
  ],
});
