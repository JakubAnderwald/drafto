// eslint-disable-next-line @typescript-eslint/no-require-imports -- config plugins are CommonJS
const plugin = require("../../plugins/with-ios-scene-lifecycle") as {
  patchAppDelegate: (contents: string) => string;
  setSceneManifest: (infoPlist: Record<string, unknown>) => Record<string, unknown>;
  SCENE_DELEGATE_SWIFT: string;
  MARKER: string;
};

// The AppDelegate.swift `expo prebuild` generates for Expo SDK 55 (trimmed to the
// parts the plugin anchors on).
const APP_DELEGATE = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe("with-ios-scene-lifecycle", () => {
  describe("patchAppDelegate", () => {
    it("stops AppDelegate from creating the window and starting React Native", () => {
      const patched = plugin.patchAppDelegate(APP_DELEGATE);

      expect(patched).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
      expect(patched).not.toContain("factory.startReactNative");
      expect(patched).toContain("self.launchOptions = launchOptions");
      expect(patched).toContain("var launchOptions: [UIApplication.LaunchOptionsKey: Any]?");
      // The factory is still created; SceneDelegate starts it.
      expect(patched).toContain("reactNativeFactory = factory");
      expect(patched).toContain(
        "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
      );
    });

    it("is idempotent", () => {
      const once = plugin.patchAppDelegate(APP_DELEGATE);
      expect(plugin.patchAppDelegate(once)).toBe(once);
    });

    it("fails prebuild when the window block is missing", () => {
      const changed = APP_DELEGATE.replace(
        "window = UIWindow(frame: UIScreen.main.bounds)",
        "window = makeWindow()",
      );
      expect(() => plugin.patchAppDelegate(changed)).toThrow(/Expo's template changed/);
    });

    it("fails prebuild when the factory property is missing", () => {
      const changed = APP_DELEGATE.replace(
        "  var reactNativeFactory: RCTReactNativeFactory?\n",
        "  var factory: RCTReactNativeFactory?\n",
      );
      expect(() => plugin.patchAppDelegate(changed)).toThrow(/reactNativeFactory/);
    });
  });

  describe("setSceneManifest", () => {
    it("declares a single-window scene backed by SceneDelegate", () => {
      const plist = plugin.setSceneManifest({ CFBundleDisplayName: "Drafto" });

      expect(plist.CFBundleDisplayName).toBe("Drafto");
      expect(plist.UIApplicationSceneManifest).toEqual({
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: "Default Configuration",
              UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
            },
          ],
        },
      });
    });
  });

  describe("SceneDelegate.swift", () => {
    const swift = plugin.SCENE_DELEGATE_SWIFT;

    it("creates the window from the scene and starts React Native in it", () => {
      expect(swift).toContain("UIWindow(windowScene: windowScene)");
      expect(swift).toContain("appDelegate.window = window");
      expect(swift).toContain(
        'factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)',
      );
    });

    it("hands a cold-start link to getInitialURL through the launch options", () => {
      expect(swift).toContain("launchOptions[.url] = context.url");
      expect(swift).toContain("launchOptions[.userActivityDictionary]");
      expect(swift).toContain('"UIApplicationLaunchOptionsUserActivityKey": activity');
    });

    it("forwards URLs and user activities to the AppDelegate callbacks", () => {
      expect(swift).toContain("openURLContexts");
      expect(swift).toContain("appDelegate?.application(UIApplication.shared, open: context.url");
      expect(swift).toContain(
        "func scene(_ scene: UIScene, continue userActivity: NSUserActivity)",
      );
    });
  });
});
