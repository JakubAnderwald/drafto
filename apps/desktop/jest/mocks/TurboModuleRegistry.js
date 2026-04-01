// Mock for TurboModuleRegistry — provides stub implementations for all
// native TurboModules used by React Native internals during testing.
// This is needed because RN 0.81+ uses TurboModules (not NativeModules) for
// platform constants, device info, and other core modules.

const turboModules = {
  PlatformConstants: {
    getConstants: () => ({
      forceTouchAvailable: false,
      interfaceIdiom: "pad",
      isTesting: true,
      osVersion: "14.0",
      reactNativeVersion: { major: 0, minor: 81, patch: 6 },
      systemName: "macOS",
    }),
  },
  DeviceInfo: {
    getConstants: () => ({
      Dimensions: {
        window: { width: 1440, height: 900, scale: 2, fontScale: 1 },
        screen: { width: 1440, height: 900, scale: 2, fontScale: 1 },
      },
    }),
  },
  SourceCode: {
    getConstants: () => ({
      scriptURL: "http://localhost:8081/index.bundle",
    }),
  },
  UIManager: {
    getConstants: () => ({}),
    getConstantsForViewManager: jest.fn(),
    getDefaultEventTypes: jest.fn(() => []),
    createView: jest.fn(),
    updateView: jest.fn(),
    manageChildren: jest.fn(),
    setChildren: jest.fn(),
    removeSubviewsFromContainerWithID: jest.fn(),
    replaceExistingNonRootView: jest.fn(),
    measure: jest.fn(),
    measureInWindow: jest.fn(),
    measureLayout: jest.fn(),
    findSubviewIn: jest.fn(),
    dispatchViewManagerCommand: jest.fn(),
    focus: jest.fn(),
    blur: jest.fn(),
    setJSResponder: jest.fn(),
    clearJSResponder: jest.fn(),
    configureNextLayoutAnimation: jest.fn(),
    removeRootView: jest.fn(),
    hasViewManagerConfig: jest.fn(() => false),
    getViewManagerConfig: jest.fn(() => ({})),
  },
  DevSettings: {
    addMenuItem: jest.fn(),
    reload: jest.fn(),
  },
  Timing: {
    createTimer: jest.fn(),
    deleteTimer: jest.fn(),
  },
  Appearance: {
    getColorScheme: jest.fn(() => "light"),
    setColorScheme: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  StatusBarManager: {
    getHeight: jest.fn((callback) => callback({ height: 0 })),
    setStyle: jest.fn(),
    setHidden: jest.fn(),
    getConstants: () => ({ HEIGHT: 0, DEFAULT_BACKGROUND_COLOR: 0 }),
  },
  KeyboardObserver: {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  AlertManager: {
    alertWithArgs: jest.fn(),
  },
  Networking: {
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    sendRequest: jest.fn(),
    abortRequest: jest.fn(),
    clearCookies: jest.fn(),
  },
  WebSocketModule: {
    connect: jest.fn(),
    send: jest.fn(),
    sendBinary: jest.fn(),
    ping: jest.fn(),
    close: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
  I18nManager: {
    allowRTL: jest.fn(),
    forceRTL: jest.fn(),
    swapLeftAndRightInRTL: jest.fn(),
    getConstants: () => ({
      isRTL: false,
      doLeftAndRightSwapInRTL: true,
    }),
  },
  ExceptionsManager: {
    reportFatalException: jest.fn(),
    reportSoftException: jest.fn(),
    updateExceptionMessage: jest.fn(),
    dismissRedbox: jest.fn(),
    reportException: jest.fn(),
  },
  LogBox: {
    show: jest.fn(),
    hide: jest.fn(),
  },
  BlobModule: {
    getConstants: () => ({ BLOB_URI_SCHEME: "content", BLOB_URI_HOST: null }),
    addNetworkingHandler: jest.fn(),
    addWebSocketHandler: jest.fn(),
    removeWebSocketHandler: jest.fn(),
    sendOverSocket: jest.fn(),
    createFromParts: jest.fn(),
    release: jest.fn(),
  },
  LinkingManager: {
    getInitialURL: jest.fn(() => Promise.resolve(null)),
    canOpenURL: jest.fn(() => Promise.resolve(true)),
    openURL: jest.fn(() => Promise.resolve()),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    getConstants: () => ({}),
  },
  AccessibilityInfo: {
    isBoldTextEnabled: jest.fn(() => Promise.resolve(false)),
    isGrayscaleEnabled: jest.fn(() => Promise.resolve(false)),
    isInvertColorsEnabled: jest.fn(() => Promise.resolve(false)),
    isReduceMotionEnabled: jest.fn(() => Promise.resolve(false)),
    prefersCrossFadeTransitions: jest.fn(() => Promise.resolve(false)),
    isReduceTransparencyEnabled: jest.fn(() => Promise.resolve(false)),
    isScreenReaderEnabled: jest.fn(() => Promise.resolve(false)),
    isAccessibilityServiceEnabled: jest.fn(() => Promise.resolve(false)),
    setAccessibilityFocus: jest.fn(),
    announceForAccessibility: jest.fn(),
    announceForAccessibilityWithOptions: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    getRecommendedTimeoutMillis: jest.fn(() => Promise.resolve(0)),
  },
  FrameRateLogger: {
    setGlobalOptions: jest.fn(),
    setContext: jest.fn(),
    beginScroll: jest.fn(),
    endScroll: jest.fn(),
  },
  NativeAnimatedModule: {
    startOperationBatch: jest.fn(),
    finishOperationBatch: jest.fn(),
    createAnimatedNode: jest.fn(),
    updateAnimatedNodeConfig: jest.fn(),
    getValue: jest.fn(),
    startListeningToAnimatedNodeValue: jest.fn(),
    stopListeningToAnimatedNodeValue: jest.fn(),
    connectAnimatedNodes: jest.fn(),
    disconnectAnimatedNodes: jest.fn(),
    startAnimatingNode: jest.fn(),
    stopAnimation: jest.fn(),
    setAnimatedNodeValue: jest.fn(),
    setAnimatedNodeOffset: jest.fn(),
    flattenAnimatedNodeOffset: jest.fn(),
    extractAnimatedNodeOffset: jest.fn(),
    connectAnimatedNodeToView: jest.fn(),
    disconnectAnimatedNodeFromView: jest.fn(),
    restoreDefaultValues: jest.fn(),
    dropAnimatedNode: jest.fn(),
    addAnimatedEventToView: jest.fn(),
    removeAnimatedEventFromView: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    queueAndExecuteBatchedOperations: jest.fn(),
  },
};

module.exports = {
  getEnforcing: jest.fn((name) => {
    if (turboModules[name]) {
      return turboModules[name];
    }
    // Return a proxy that returns jest.fn() for any property access
    // This handles any TurboModule we haven't explicitly mocked
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "getConstants") return () => ({});
          if (prop === "addListener") return jest.fn();
          if (prop === "removeListeners") return jest.fn();
          return jest.fn();
        },
      },
    );
  }),
  get: jest.fn((name) => turboModules[name] || null),
};
