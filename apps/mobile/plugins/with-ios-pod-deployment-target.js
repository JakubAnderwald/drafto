const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Expo config plugin that raises every pod target's IPHONEOS_DEPLOYMENT_TARGET
 * to at least the app's own floor during `expo prebuild`.
 *
 * Xcode 27 rejects deployment targets below iOS 15.0 as a hard error ("The iOS
 * Simulator deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 9.0, but
 * the range of supported deployment target versions is 15.0 to 27.0.x").
 * Several pods (SDWebImage, GoogleSignIn, AppAuth, GTMSessionFetcher, RNSVG…)
 * still declare 9.0–12.4, mostly on their resource-bundle targets, so every
 * iOS build fails before compiling anything. Targets already at or above the
 * floor are left alone.
 */
const MIN_IOS_DEPLOYMENT_TARGET = "15.1";
const MARKER = "drafto: minimum pod deployment target";

function patchPodfile(contents, minTarget = MIN_IOS_DEPLOYMENT_TARGET) {
  if (contents.includes(MARKER)) {
    return contents;
  }

  const postInstallPatch = `
    # ${MARKER} (Xcode 27 rejects < 15.0)
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || Gem::Version.new(current) < Gem::Version.new('${minTarget}')
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${minTarget}'
        end
      end
    end
`;

  // Same anchor as with-ios-swift-concurrency: the `end` closing
  // `post_install do |installer|`, followed by the target block's `end`.
  return contents.replace(/(\n  end\nend\s*$)/, `\n${postInstallPatch}$1`);
}

function withIosPodDeploymentTarget(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, "Podfile");

      if (!fs.existsSync(podfilePath)) {
        return config;
      }

      const contents = fs.readFileSync(podfilePath, "utf-8");
      fs.writeFileSync(podfilePath, patchPodfile(contents));
      return config;
    },
  ]);
}

module.exports = withIosPodDeploymentTarget;
module.exports.patchPodfile = patchPodfile;
module.exports.MIN_IOS_DEPLOYMENT_TARGET = MIN_IOS_DEPLOYMENT_TARGET;
