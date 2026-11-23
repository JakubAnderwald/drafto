import Constants from "expo-constants";

/**
 * "1.7.0 (82)": the marketing version, plus the build number when there is one.
 * "Unknown" when the version can't be read.
 */
export function formatAppVersion(
  version: string | null | undefined,
  buildNumber: string | null | undefined,
): string {
  if (!version) return "Unknown";
  return buildNumber ? `${version} (${buildNumber})` : version;
}

/**
 * The running app's version for Settings → About (PrimeTestLab 11035 S-01). The version is
 * `app.config.ts`'s `version` (package.json). The build number is the binary's
 * `CFBundleVersion`, which expo-constants reads only on iOS; on Android it exposes no
 * `versionCode`, so Android shows the version alone.
 */
export function getAppVersionLabel(): string {
  return formatAppVersion(Constants.expoConfig?.version, Constants.platform?.ios?.buildNumber);
}
