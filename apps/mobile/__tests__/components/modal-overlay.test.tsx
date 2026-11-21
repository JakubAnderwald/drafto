import React, { useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  Text,
  type HostInstance,
} from "react-native";
import { render as rtlRender, fireEvent } from "@testing-library/react-native";

import {
  ModalOverlay,
  ModalOverlayHost,
  drawsInActivityWindow,
} from "../../src/components/ui/modal-overlay";

/** Renders under a ModalOverlayHost, as the app's root layout does. */
function render(ui: React.ReactElement) {
  return rtlRender(ui, {
    wrapper: ({ children }) => <ModalOverlayHost>{children}</ModalOverlayHost>,
  });
}

type BackListener = () => boolean | null | undefined;

/** Records BackHandler listeners; `press()` calls them newest first, as Android does. */
function spyOnBackHandler() {
  const listeners: BackListener[] = [];
  const removes: jest.Mock[] = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
    listeners.push(listener);
    const remove = jest.fn(() => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    });
    removes.push(remove);
    return { remove };
  });
  return {
    listeners,
    removes,
    press(): boolean {
      for (const listener of [...listeners].reverse()) {
        if (listener()) return true;
      }
      return false;
    },
  };
}

function Dialog({
  visible,
  onRequestClose = jest.fn(),
  label = "Dialog content",
}: {
  visible: boolean;
  onRequestClose?: () => void;
  label?: string;
}) {
  return (
    <ModalOverlay visible={visible} onRequestClose={onRequestClose} testID="test-overlay">
      <Text>{label}</Text>
    </ModalOverlay>
  );
}

describe("ModalOverlay on Android", () => {
  beforeEach(() => {
    // A spy on the same method is reused across tests; start each with no calls.
    jest.clearAllMocks();
    jest.replaceProperty(Platform, "OS", "android");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("draws in the activity window on Android only", () => {
    expect(drawsInActivityWindow()).toBe(true);
    jest.replaceProperty(Platform, "OS", "ios");
    expect(drawsInActivityWindow()).toBe(false);
  });

  it("renders nothing while hidden and the content in the host while visible", () => {
    const { queryByText, getByTestId, queryByTestId, rerender, UNSAFE_queryByType } = render(
      <Dialog visible={false} />,
    );
    expect(queryByText("Dialog content")).toBeNull();
    expect(queryByTestId("test-overlay")).toBeNull();

    rerender(<Dialog visible />);
    expect(getByTestId("test-overlay")).toHaveTextContent("Dialog content");
    // No RN Modal: that would be a window of its own, with the OS theme's nav bar.
    expect(UNSAFE_queryByType(Modal)).toBeNull();

    rerender(<Dialog visible={false} />);
    expect(queryByText("Dialog content")).toBeNull();
  });

  it("draws above the app, not inside the component that renders it", () => {
    const { getByTestId } = render(<Dialog visible />);
    // Hidden from accessibility while the overlay is open, which RNTL skips by default.
    const app = getByTestId("modal-overlay-app", { includeHiddenElements: true });
    const layer = getByTestId("test-overlay");

    expect(app).not.toContainElement(layer);
  });

  it("follows its owner's state", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <ModalOverlay visible onRequestClose={jest.fn()}>
          <Pressable onPress={() => setCount((c) => c + 1)} testID="increment">
            <Text>{`Count ${count}`}</Text>
          </Pressable>
        </ModalOverlay>
      );
    }
    const { getByTestId, getByText } = render(<Counter />);

    fireEvent.press(getByTestId("increment"));
    fireEvent.press(getByTestId("increment"));
    expect(getByText("Count 2")).toBeTruthy();
  });

  it("hides the app from TalkBack only while an overlay is open", () => {
    const { getByTestId, rerender } = render(<Dialog visible={false} />);
    expect(getByTestId("modal-overlay-app").props.importantForAccessibility).toBe("auto");

    rerender(<Dialog visible />);
    expect(
      getByTestId("modal-overlay-app", { includeHiddenElements: true }).props
        .importantForAccessibility,
    ).toBe("no-hide-descendants");

    rerender(<Dialog visible={false} />);
    expect(getByTestId("modal-overlay-app").props.importantForAccessibility).toBe("auto");
  });

  it("blocks touches from reaching the app behind it", () => {
    const { getByTestId } = render(<Dialog visible />);

    expect(getByTestId("test-overlay").props.onStartShouldSetResponder()).toBe(true);
  });

  it("sends hardware back to onRequestClose while visible, and stops when hidden", () => {
    const back = spyOnBackHandler();
    const onRequestClose = jest.fn();
    const { rerender } = render(<Dialog visible={false} onRequestClose={onRequestClose} />);
    expect(back.listeners).toHaveLength(0);

    rerender(<Dialog visible onRequestClose={onRequestClose} />);
    expect(back.press()).toBe(true);
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    rerender(<Dialog visible={false} onRequestClose={onRequestClose} />);
    expect(back.listeners).toHaveLength(0);
    expect(back.press()).toBe(false);
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("calls the latest onRequestClose without re-registering the back listener", () => {
    const back = spyOnBackHandler();
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = render(<Dialog visible onRequestClose={first} />);

    rerender(<Dialog visible onRequestClose={second} />);
    back.press();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(BackHandler.addEventListener).toHaveBeenCalledTimes(1);
  });

  it("gives back presses to the top overlay only", () => {
    const back = spyOnBackHandler();
    const bottom = jest.fn();
    const top = jest.fn();
    render(
      <>
        <ModalOverlay visible onRequestClose={bottom}>
          <Text>Bottom</Text>
        </ModalOverlay>
        <ModalOverlay visible onRequestClose={top}>
          <Text>Top</Text>
        </ModalOverlay>
      </>,
    );

    back.press();
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
  });

  it("removes the overlay and its back listener when the owner unmounts", () => {
    const back = spyOnBackHandler();
    function Screen({ showDialog }: { showDialog: boolean }) {
      return showDialog ? <Dialog visible /> : <Text>Elsewhere</Text>;
    }
    const { queryByText, rerender } = render(<Screen showDialog />);
    expect(queryByText("Dialog content")).toBeTruthy();

    rerender(<Screen showDialog={false} />);
    expect(queryByText("Dialog content")).toBeNull();
    expect(back.listeners).toHaveLength(0);
    expect(back.removes[0]).toHaveBeenCalled();
  });

  it("fades in on the native driver", () => {
    const timing = jest.spyOn(Animated, "timing");
    const { getByTestId } = render(<Dialog visible />);

    expect(getByTestId("test-overlay")).toHaveStyle({ opacity: 0 });
    expect(timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toValue: 1, useNativeDriver: true }),
    );
  });

  it("moves TalkBack's focus to initialFocusRef once it has faded in", () => {
    jest.useFakeTimers();
    try {
      const send = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation();
      function Titled() {
        const titleRef = React.useRef<Text>(null);
        return (
          <ModalOverlay visible onRequestClose={jest.fn()} initialFocusRef={titleRef}>
            <Text ref={titleRef}>Title</Text>
          </ModalOverlay>
        );
      }
      const { getByText } = render(<Titled />);
      expect(send).not.toHaveBeenCalled();

      jest.advanceTimersByTime(150);

      expect(send).toHaveBeenCalledTimes(1);
      const [target, event] = send.mock.calls[0] as [HostInstance, string];
      expect(event).toBe("focus");
      // The Text the ref points at, the dialog's title.
      expect((target as unknown as { props: { children: string } }).props.children).toBe("Title");
      expect(getByText("Title")).toBeTruthy();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("moves no focus without an initialFocusRef, or once closed before fading in", () => {
    jest.useFakeTimers();
    try {
      const send = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation();
      const { rerender } = render(<Dialog visible />);
      jest.advanceTimersByTime(150);
      expect(send).not.toHaveBeenCalled();

      function Titled({ visible }: { visible: boolean }) {
        const titleRef = React.useRef<Text>(null);
        return (
          <ModalOverlay visible={visible} onRequestClose={jest.fn()} initialFocusRef={titleRef}>
            <Text ref={titleRef}>Title</Text>
          </ModalOverlay>
        );
      }
      rerender(<Titled visible />);
      rerender(<Titled visible={false} />);
      jest.advanceTimersByTime(150);
      expect(send).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it("throws without a ModalOverlayHost, instead of silently drawing nothing", () => {
    jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => rtlRender(<Dialog visible />)).toThrow(
      "ModalOverlay must be used within a ModalOverlayHost",
    );
  });
});

describe("ModalOverlay on iOS", () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, "OS", "ios");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is an RN Modal, with or without a host", () => {
    const onRequestClose = jest.fn();
    const { UNSAFE_getByType } = rtlRender(<Dialog visible onRequestClose={onRequestClose} />);
    const modal = UNSAFE_getByType(Modal);

    expect(modal.props).toMatchObject({
      visible: true,
      transparent: true,
      animationType: "fade",
      onRequestClose,
      testID: "test-overlay",
    });
  });

  it("registers no back handler", () => {
    const back = spyOnBackHandler();
    render(<Dialog visible />);

    expect(back.listeners).toHaveLength(0);
  });

  it("keeps the app reachable to VoiceOver: the Modal window handles focus itself", () => {
    const { getByTestId } = render(<Dialog visible />);

    expect(getByTestId("modal-overlay-app").props.importantForAccessibility).toBe("auto");
  });
});

describe("ModalOverlayHost", () => {
  it("renders its children", () => {
    const { getByText } = rtlRender(
      <ModalOverlayHost>
        <Text>App</Text>
      </ModalOverlayHost>,
    );

    expect(getByText("App")).toBeTruthy();
  });
});
