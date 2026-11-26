import type { ConfigContext, ExpoConfig } from "expo/config";
import { XML } from "expo/config-plugins";

import appConfig from "../../app.config";

type XMLObject = XML.XMLObject;
type XMLValue = XML.XMLValue;

// The attachment cache lives in Expo's Documents directory, which on Android
// is `context.filesDir`: Auto Backup's `file` domain. Nothing in the app sets
// backup rules, so the built manifest gets expo-secure-store's
// (`expo prebuild` adds `android:fullBackupContent` and
// `android:dataExtractionRules`), and those only include the `sharedpref`
// domain. Once a rules file has an <include>, Auto Backup backs up only what
// it includes, so the cache stays out of Android backups (ADR-0107). These
// tests run secure-store's own manifest plugin with app.config.ts's options
// and read the rules files it names, so a change to the app or a secure-store
// upgrade that breaks the chain fails them. A plugin from another package that
// writes backup attributes isn't seen here: the manual prebuild check in
// docs/architecture/testing.md covers the whole built manifest.

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

type ApplicationAttributes = Record<string, string>;
interface ManifestModConfig {
  mods: {
    android: {
      manifest: (config: object) => Promise<{
        modResults: { manifest: { application: { $: ApplicationAttributes }[] } };
      }>;
    };
  };
}
type SecureStorePlugin = (config: object, options: object) => ManifestModConfig;

/**
 * The <application> attributes expo-secure-store's own plugin writes, run with
 * app.config.ts's options on the template's manifest after Expo's
 * withAllowBackup (`android:allowBackup="true"`, no rules file).
 */
async function secureStoreApplicationAttributes(): Promise<ApplicationAttributes> {
  const entry = secureStoreEntry();
  const options = Array.isArray(entry) ? ((entry[1] ?? {}) as object) : {};
  const loaded = jest.requireActual<{ default?: SecureStorePlugin } | SecureStorePlugin>(
    "expo-secure-store/app.plugin",
  );
  const plugin = typeof loaded === "function" ? loaded : loaded.default;
  if (!plugin) throw new Error("expo-secure-store/app.plugin exports no plugin");
  const withPlugin = plugin({ name: "drafto", slug: "drafto" }, options);
  const application = {
    $: { "android:name": ".MainApplication", "android:allowBackup": "true" },
  };
  const result = await withPlugin.mods.android.manifest({
    ...withPlugin,
    modResults: { manifest: { $: {}, application: [application] } },
    modRequest: {
      platform: "android",
      modName: "manifest",
      projectRoot: MOBILE_ROOT,
      platformProjectRoot: `${MOBILE_ROOT}/android`,
      introspect: true,
    },
  });
  return result.modResults.manifest.application[0].$;
}

/** The rules file an `@xml/<name>` resource names, in the installed expo-secure-store. */
function rulesFile(resource: string | undefined): string {
  const name = /^@xml\/(\w+)$/.exec(resource ?? "")?.[1];
  if (!name) throw new Error(`not an @xml resource: ${resource}`);
  return fs.readFileSync(`${RULES_DIR}/${name}.xml`, "utf8");
}

/** Every element named `name` in the parsed tree, at any depth. */
function elementsNamed(node: XMLValue | undefined, name: string): XMLValue[] {
  if (Array.isArray(node)) return node.flatMap((child) => elementsNamed(child, name));
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => {
    // xml2js keeps attributes under `$` and text under `_`.
    if (key === "$" || key === "_") return [];
    const own = key === name ? (Array.isArray(value) ? value : [value ?? null]) : [];
    return [...own, ...elementsNamed(value, name)];
  });
}

function isElement(value: XMLValue): value is XMLObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The `domain` of every <include> element inside `<section>` of `xml`. The
 * file is parsed as XML, so a commented-out <include> doesn't count.
 */
async function includeDomains(xml: string, section: string): Promise<string[]> {
  const sections = elementsNamed(await XML.parseXMLAsync(xml), section);
  if (sections.length === 0) throw new Error(`no <${section}> in the rules file`);
  // An empty <section/> parses to a string: it has no <include>.
  const includes = sections.filter(isElement).flatMap((element) => {
    const children = element.include;
    return Array.isArray(children) ? children : [];
  });
  return includes.map((include) => {
    const attributes = isElement(include) ? include.$ : undefined;
    const domain = attributes && isElement(attributes) ? attributes.domain : undefined;
    if (typeof domain !== "string") {
      throw new Error(`an <include> without a readable domain: ${JSON.stringify(include)}`);
    }
    return domain;
  });
}

describe("Android Auto Backup leaves the attachment cache out", () => {
  let attributes: ApplicationAttributes;
  beforeAll(async () => {
    attributes = await secureStoreApplicationAttributes();
  });

  it("keeps expo-secure-store's backup rules on (configureAndroidBackup isn't false)", () => {
    const entry = secureStoreEntry();
    expect(entry).toBeDefined();
    if (Array.isArray(entry)) {
      const options = (entry[1] ?? {}) as Record<string, unknown>;
      expect(options.configureAndroidBackup).not.toBe(false);
    }
  });

  it("gets its backup rules written into the manifest by expo-secure-store's plugin", () => {
    expect(attributes["android:fullBackupContent"]).toBe("@xml/secure_store_backup_rules");
    expect(attributes["android:dataExtractionRules"]).toBe(
      "@xml/secure_store_data_extraction_rules",
    );
  });

  it("uses rules that include only the sharedpref domain (Android 11 and lower)", async () => {
    const xml = rulesFile(attributes["android:fullBackupContent"]);
    const domains = await includeDomains(xml, "full-backup-content");
    // With no <include> at all, everything would be backed up.
    expect(domains.length).toBeGreaterThan(0);
    expect(domains.every((domain) => domain === "sharedpref")).toBe(true);
  });

  it.each(["cloud-backup", "device-transfer"])(
    "uses rules whose %s includes only the sharedpref domain (Android 12 and higher)",
    async (section) => {
      const xml = rulesFile(attributes["android:dataExtractionRules"]);
      const domains = await includeDomains(xml, section);
      expect(domains.length).toBeGreaterThan(0);
      expect(domains.every((domain) => domain === "sharedpref")).toBe(true);
    },
  );

  it("reads only active <include> elements, not commented-out ones", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <!-- <include domain="sharedpref" path="."/> -->
  </cloud-backup>
  <device-transfer>
    <include domain="sharedpref" path="."/>
    <!-- <include domain="file" path="."/> -->
  </device-transfer>
</data-extraction-rules>`;
    expect(await includeDomains(xml, "cloud-backup")).toEqual([]);
    expect(await includeDomains(xml, "device-transfer")).toEqual(["sharedpref"]);
  });

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
