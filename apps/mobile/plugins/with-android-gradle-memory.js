const { withGradleProperties } = require("expo/config-plugins");

/**
 * Expo config plugin that sizes the Gradle daemon's JVM for release builds.
 *
 * `expo prebuild --clean` regenerates android/gradle.properties from Expo's
 * template, which pins `org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m`.
 * 512 MiB of Metaspace is no longer enough for `bundleRelease`: Gradle started
 * warning "The Daemon will expire after the build after running out of JVM
 * Metaspace", then `:app:compileReleaseArtProfile` failed and the daemon logged
 * `java.lang.OutOfMemoryError: Metaspace` over and over. A daemon out of
 * Metaspace cannot load the classes it needs to report a failure, so the build
 * never exited: it went silent, and days later the lane and its daemon were
 * still hung.
 *
 * - `-XX:MaxMetaspaceSize=1024m` doubles the class-metadata ceiling. The heap
 *   stays at the template's 2 GiB: Metaspace is the pool that ran out, and no
 *   beta build has warned about heap.
 * - `-XX:+ExitOnOutOfMemoryError` makes the daemon exit on its first
 *   OutOfMemoryError (heap or Metaspace), so a future shortfall fails the build in
 *   seconds ("Gradle build daemon disappeared unexpectedly") instead of hanging,
 *   and leaves no wedged daemon behind.
 *
 * The android/ project is regenerated on every prebuild, so this must live as a
 * config plugin rather than a hand edit to the generated gradle.properties.
 */
const GRADLE_JVM_ARGS = "-Xmx2048m -XX:MaxMetaspaceSize=1024m -XX:+ExitOnOutOfMemoryError";

function withAndroidGradleMemory(config) {
  return withGradleProperties(config, (config) => {
    const properties = config.modResults;
    const key = "org.gradle.jvmargs";

    const existing = properties.find((p) => p.type === "property" && p.key === key);
    if (existing) {
      existing.value = GRADLE_JVM_ARGS;
    } else {
      properties.push({ type: "property", key, value: GRADLE_JVM_ARGS });
    }

    return config;
  });
}

module.exports = withAndroidGradleMemory;
