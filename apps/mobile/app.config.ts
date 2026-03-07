import { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Drafto",
  slug: "drafto",
  owner: "drafto",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  scheme: "drafto",
  runtimeVersion: {
    policy: "appVersion",
  },
  updates: {
    url: "https://u.expo.dev/drafto",
  },
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
      projectId: process.env.EAS_PROJECT_ID,
    },
  },
  plugins: ["expo-router", "expo-secure-store"],
});
