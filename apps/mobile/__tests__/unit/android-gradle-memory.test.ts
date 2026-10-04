import { AndroidConfig, type ExportedConfig } from "expo/config-plugins";
import type { ConfigContext, ExpoConfig } from "expo/config";

import appConfig from "../../app.config";
import withAndroidGradleMemory from "../../plugins/with-android-gradle-memory";

type PropertiesItem = AndroidConfig.Properties.PropertiesItem;

// The Gradle daemon settings `expo prebuild --clean` writes into
// android/gradle.properties (Expo SDK 55 template). Its 512 MiB Metaspace ceiling
// is what ran out and hung the release build, so it is the input that matters.
const TEMPLATE_JVM_ARGS_LINE = "org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m";
const EXPO_TEMPLATE = [
  "# Specifies the JVM arguments used for the daemon process.",
  "# The setting is particularly useful for tweaking memory settings.",
  "# Default value: -Xmx512m -XX:MaxMetaspaceSize=256m",
  TEMPLATE_JVM_ARGS_LINE,
  "",
  "org.gradle.parallel=true",
  "android.useAndroidX=true",
].join("\n");

// Pinned literally rather than imported from the plugin, so changing the daemon's
// memory is a deliberate two-file edit.
const EXPECTED_JVM_ARGS = "-Xmx2048m -XX:MaxMetaspaceSize=1024m -XX:+ExitOnOutOfMemoryError";

// Runs the plugin through the real withGradleProperties mod chain — the same
// function `expo prebuild` invokes — against a parsed gradle.properties file.
async function applyPlugin(contents: string): Promise<PropertiesItem[]> {
  const config: ExportedConfig = withAndroidGradleMemory({ name: "Drafto", slug: "drafto" });
  const mod = config.mods?.android?.gradleProperties;
  if (!mod) {
    throw new Error("with-android-gradle-memory registered no android.gradleProperties mod");
  }

  const result = await mod({
    ...config,
    modResults: AndroidConfig.Properties.parsePropertiesFile(contents),
    modRequest: {
      projectRoot: "/project",
      platformProjectRoot: "/project/android",
      modName: "gradleProperties",
      platform: "android",
      introspect: false,
    },
    modRawConfig: { name: "Drafto", slug: "drafto" },
  });
  return result.modResults;
}

async function applyPluginToString(contents: string): Promise<string> {
  return AndroidConfig.Properties.propertiesListToString(await applyPlugin(contents));
}

function jvmArgsValues(properties: PropertiesItem[]): string[] {
  return properties.flatMap((p) =>
    p.type === "property" && p.key === "org.gradle.jvmargs" ? [p.value] : [],
  );
}

describe("with-android-gradle-memory", () => {
  it("raises the template's 512 MiB Metaspace ceiling to 1 GiB, keeping the 2 GiB heap", async () => {
    expect(jvmArgsValues(await applyPlugin(EXPO_TEMPLATE))).toEqual([EXPECTED_JVM_ARGS]);
  });

  it("makes the daemon exit on OutOfMemoryError instead of hanging", async () => {
    // A daemon out of Metaspace cannot load the classes it needs to report the
    // failure; without this flag the build goes silent rather than failing.
    const [jvmArgs] = jvmArgsValues(await applyPlugin(EXPO_TEMPLATE));
    expect(jvmArgs?.split(" ")).toContain("-XX:+ExitOnOutOfMemoryError");
  });

  it("adds the setting when the template stops declaring it", async () => {
    expect(jvmArgsValues(await applyPlugin("org.gradle.parallel=true"))).toEqual([
      EXPECTED_JVM_ARGS,
    ]);
  });

  it("leaves every other property and comment untouched", async () => {
    expect(await applyPluginToString(EXPO_TEMPLATE)).toBe(
      EXPO_TEMPLATE.replace(TEMPLATE_JVM_ARGS_LINE, `org.gradle.jvmargs=${EXPECTED_JVM_ARGS}`),
    );
  });

  it("is idempotent when prebuild runs over an already-patched file", async () => {
    const once = await applyPluginToString(EXPO_TEMPLATE);
    expect(await applyPluginToString(once)).toBe(once);
  });

  it("is registered in app.config.ts, so every release lane's prebuild applies it", () => {
    const config: ExpoConfig = appConfig({
      config: {},
      projectRoot: "apps/mobile",
      staticConfigPath: null,
      packageJsonPath: null,
    } satisfies ConfigContext);

    expect(config.plugins).toContain("./plugins/with-android-gradle-memory");
  });
});
