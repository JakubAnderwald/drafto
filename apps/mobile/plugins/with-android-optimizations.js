const { withGradleProperties } = require("expo/config-plugins");

/**
 * Expo config plugin that sets Android Gradle build optimizations:
 * - org.gradle.caching=true (faster incremental builds)
 * - android.enableMinifyInReleaseBuilds=true (R8 shrinking for smaller APKs/AABs)
 * - android.enableShrinkResourcesInReleaseBuilds=true (remove unused resources)
 */
function withAndroidOptimizations(config) {
  return withGradleProperties(config, (config) => {
    const properties = config.modResults;

    const optimizations = {
      "org.gradle.caching": "true",
      "android.enableMinifyInReleaseBuilds": "true",
      "android.enableShrinkResourcesInReleaseBuilds": "true",
    };

    for (const [key, value] of Object.entries(optimizations)) {
      const existing = properties.find((p) => p.type === "property" && p.key === key);
      if (existing) {
        existing.value = value;
      } else {
        properties.push({ type: "property", key, value });
      }
    }

    return config;
  });
}

module.exports = withAndroidOptimizations;
