// eslint-disable-next-line @typescript-eslint/no-require-imports -- config plugins are CommonJS
const plugin = require("../../plugins/with-ios-pod-deployment-target") as {
  patchPodfile: (contents: string, minTarget?: string) => string;
  MIN_IOS_DEPLOYMENT_TARGET: string;
};

// Shape of the Podfile `expo prebuild` generates: post_install is the last block
// inside `target 'Drafto' do … end`.
const PODFILE = `platform :ios, podfile_properties['ios.deploymentTarget'] || '15.1'

target 'Drafto' do
  use_expo_modules!

  post_install do |installer|
    react_native_post_install(installer)
  end
end
`;

describe("with-ios-pod-deployment-target", () => {
  it("raises pod targets inside the post_install block", () => {
    const patched = plugin.patchPodfile(PODFILE);

    expect(patched).toContain("Gem::Version.new('15.1')");
    expect(patched).toContain("build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.1'");
    // Inserted before post_install's `end`, so the Podfile still ends with both closers.
    expect(patched.indexOf("IPHONEOS_DEPLOYMENT_TARGET")).toBeGreaterThan(
      patched.indexOf("react_native_post_install"),
    );
    expect(patched.trimEnd().endsWith("  end\nend")).toBe(true);
  });

  it("is idempotent", () => {
    const once = plugin.patchPodfile(PODFILE);
    expect(plugin.patchPodfile(once)).toBe(once);
  });

  it("only raises, never lowers, a pod's target", () => {
    // The Ruby guard compares versions, so a pod already at 16.0 keeps 16.0.
    expect(plugin.patchPodfile(PODFILE)).toContain(
      "current.nil? || Gem::Version.new(current) < Gem::Version.new('15.1')",
    );
  });

  it("matches the app's own deployment-target floor", () => {
    expect(plugin.MIN_IOS_DEPLOYMENT_TARGET).toBe("15.1");
  });
});
