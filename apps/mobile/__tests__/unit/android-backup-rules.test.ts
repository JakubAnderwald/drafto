import type { ConfigContext, ExpoConfig } from "expo/config";

import appConfig from "../../app.config";

// The attachment cache lives in Expo's Documents directory, which on Android
// is `context.filesDir`: Auto Backup's `file` domain. Nothing in the app sets
// backup rules, so the built manifest gets expo-secure-store's
// (`expo prebuild` adds `android:fullBackupContent` and
// `android:dataExtractionRules`), and those only include the `sharedpref`
// domain. Once a rules file has an <include>, Auto Backup backs up only what
// it includes, so the cache stays out of Android backups (ADR-0099). These
// tests fail when a change to the app or an upgrade breaks that chain.

// Node's fs, read through jest: the mobile tsconfig has no Node types.
interface ReadFs {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}
const fs = jest.requireActual<ReadFs>("fs");

const MOBILE_ROOT = (expect.getState().testPath ?? "").replace(/\/__tests__\/.*$/, "");
// The installed expo-secure-store, the copy `expo prebuild` and the build
// use. Jest's require has Node's `resolve`; the tsconfig doesn't know it.
const SECURE_STORE_ROOT = (require as unknown as { resolve(id: string): string })
  .resolve("expo-secure-store/package.json")
  .replace(/\/package\.json$/, "");
const RULES_DIR = `${SECURE_STORE_ROOT}/android/src/main/res/xml`;

const config: ExpoConfig = appConfig({
  config: {},
  projectRoot: "apps/mobile",
  staticConfigPath: null,
  packageJsonPath: null,
} satisfies ConfigContext);

function secureStoreEntry(): unknown {
  return (config.plugins ?? []).find(
    (plugin) =>
      plugin === "expo-secure-store" ||
      (Array.isArray(plugin) && plugin[0] === "expo-secure-store"),
  );
}

/** The `domain` of every <include> inside `<section>…</section>` of `xml`. */
function includeDomains(xml: string, section: string): string[] {
  const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(xml)?.[1];
  if (body === undefined) throw new Error(`no <${section}> in the rules file`);
  return [...body.matchAll(/<include\b[^>]*\bdomain="([^"]+)"/g)].map((match) => match[1]);
}

describe("Android Auto Backup leaves the attachment cache out", () => {
  it("keeps expo-secure-store's backup rules on (configureAndroidBackup isn't false)", () => {
    const entry = secureStoreEntry();
    expect(entry).toBeDefined();
    if (Array.isArray(entry)) {
      const options = (entry[1] ?? {}) as Record<string, unknown>;
      expect(options.configureAndroidBackup).not.toBe(false);
    }
  });

  it("uses rules that include only the sharedpref domain (Android 11 and lower)", () => {
    const xml = fs.readFileSync(`${RULES_DIR}/secure_store_backup_rules.xml`, "utf8");
    const domains = includeDomains(xml, "full-backup-content");
    // With no <include> at all, everything would be backed up.
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((domain) => domain === "sharedpref")).toBe(true);
  });

  it.each(["cloud-backup", "device-transfer"])(
    "uses rules whose %s includes only the sharedpref domain (Android 12 and higher)",
    (section) => {
      const xml = fs.readFileSync(`${RULES_DIR}/secure_store_data_extraction_rules.xml`, "utf8");
      const domains = includeDomains(xml, section);
      expect(domains.length).toBeGreaterThan(0);
      expect(domains.every((domain) => domain === "sharedpref")).toBe(true);
    },
  );

  it("has no local plugin that writes backup attributes (secure-store would then skip its rules)", () => {
    const pluginsDir = `${MOBILE_ROOT}/plugins`;
    const offenders = fs
      .readdirSync(pluginsDir)
      .filter((name) =>
        /fullBackupContent|dataExtractionRules|allowBackup|backupAgent/.test(
          fs.readFileSync(`${pluginsDir}/${name}`, "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
