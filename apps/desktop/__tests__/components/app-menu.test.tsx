import React from "react";
import { View } from "react-native";

import { render, fireEvent, act } from "../helpers/test-utils";
import { AppMenu } from "@/components/sidebar/app-menu";
import { DELETE_ACCOUNT_OFFLINE_NOTE } from "@/components/sidebar/delete-account-panel";

type TestInstance = ReturnType<ReturnType<typeof render>["getByTestId"]>;

const isDisabled = (node: TestInstance) => node.props.accessibilityState?.disabled === true;
const isExpanded = (node: TestInstance) => node.props.accessibilityState?.expanded === true;

function renderMenu({ isOffline = false }: { isOffline?: boolean } = {}) {
  const onSignOut = jest.fn();
  const onDeleteAccount = jest.fn();
  const utils = render(
    <AppMenu onSignOut={onSignOut} onDeleteAccount={onDeleteAccount} isOffline={isOffline}>
      {({ trigger, onAnchorLayout }) => (
        <View testID="anchor" onLayout={onAnchorLayout}>
          {trigger}
        </View>
      )}
    </AppMenu>,
  );
  return { ...utils, onSignOut, onDeleteAccount };
}

describe("AppMenu", () => {
  it("renders the content and a collapsed trigger, with the menu closed", () => {
    const { getByTestId, getByLabelText, queryByTestId, queryByLabelText } = renderMenu();

    expect(getByTestId("anchor")).toBeTruthy();
    const trigger = getByLabelText("App menu");
    expect(trigger.props.testID).toBe("app-menu-trigger");
    expect(isExpanded(trigger)).toBe(false);
    expect(queryByTestId("app-menu")).toBeNull();
    expect(queryByLabelText("Sign out")).toBeNull();
    expect(queryByLabelText("Delete account")).toBeNull();
  });

  it("opens and closes from the trigger", () => {
    const { getByTestId, getByLabelText, queryByTestId } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));
    expect(getByTestId("app-menu").props.accessibilityRole).toBe("menu");
    expect(isExpanded(getByTestId("app-menu-trigger"))).toBe(true);
    expect(getByLabelText("Sign out").props.accessibilityRole).toBe("menuitem");
    expect(getByLabelText("Delete account").props.accessibilityRole).toBe("menuitem");

    fireEvent.press(getByTestId("app-menu-trigger"));
    expect(queryByTestId("app-menu")).toBeNull();
    expect(isExpanded(getByTestId("app-menu-trigger"))).toBe(false);
  });

  it("lists only Sign out and Delete account…, in that order", () => {
    const { getByTestId, getByText } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));

    expect(getByText("Sign out")).toBeTruthy();
    expect(getByText("Delete account…")).toBeTruthy();
    const items = getByTestId("app-menu").findAll(
      (node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string",
    );
    expect(items.map((item) => item.props.testID)).toEqual([
      "logout-button",
      "delete-account-menu-item",
    ]);
  });

  it("signs out and closes when Sign out is chosen", () => {
    const { getByTestId, queryByTestId, onSignOut, onDeleteAccount } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));
    fireEvent.press(getByTestId("logout-button"));

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onDeleteAccount).not.toHaveBeenCalled();
    expect(queryByTestId("app-menu")).toBeNull();
  });

  it("starts account deletion and closes when Delete account… is chosen", () => {
    const { getByTestId, queryByTestId, onSignOut, onDeleteAccount } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));
    const item = getByTestId("delete-account-menu-item");
    expect(isDisabled(item)).toBe(false);
    fireEvent.press(item);

    expect(onDeleteAccount).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();
    expect(queryByTestId("app-menu")).toBeNull();
  });

  it("does not show the offline note while online", () => {
    const { getByTestId, queryByText } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));

    expect(queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
  });

  it("disables Delete account… while offline and explains why", () => {
    const { getByTestId, getByText, UNSAFE_root, onDeleteAccount } = renderMenu({
      isOffline: true,
    });

    fireEvent.press(getByTestId("app-menu-trigger"));
    const item = getByTestId("delete-account-menu-item");
    expect(isDisabled(item)).toBe(true);
    expect(getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();

    fireEvent.press(item);
    // Invoke the Pressable's handler directly too, as a click that slipped past `disabled` would.
    const [pressable] = UNSAFE_root.findAll(
      (node) =>
        node.props.testID === "delete-account-menu-item" &&
        typeof node.props.onPress === "function",
    );
    act(() => {
      (pressable.props.onPress as () => void)();
    });

    expect(onDeleteAccount).not.toHaveBeenCalled();
    expect(getByTestId("app-menu")).toBeTruthy();
    // Sign out works offline.
    expect(isDisabled(getByTestId("logout-button"))).toBe(false);
  });

  it("closes without choosing anything when the backdrop is clicked", () => {
    const { getByTestId, queryByTestId, onSignOut, onDeleteAccount } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));
    fireEvent.press(getByTestId("app-menu-backdrop"));

    expect(queryByTestId("app-menu")).toBeNull();
    expect(queryByTestId("app-menu-backdrop")).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
    expect(onDeleteAccount).not.toHaveBeenCalled();
  });

  it("closes on Escape without choosing anything, and ignores other keys", () => {
    const { getByTestId, queryByTestId, onSignOut, onDeleteAccount } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));
    const menu = getByTestId("app-menu");
    // Focusable so it can take keyboard focus, and Escape is marked handled so AppKit does not beep.
    expect(menu.props.focusable).toBe(true);
    expect(menu.props.keyDownEvents).toEqual([{ key: "Escape" }]);

    fireEvent(menu, "keyDown", { nativeEvent: { key: "Enter" } });
    expect(getByTestId("app-menu")).toBeTruthy();

    fireEvent(getByTestId("app-menu"), "keyDown", { nativeEvent: { key: "Escape" } });
    expect(queryByTestId("app-menu")).toBeNull();
    expect(isExpanded(getByTestId("app-menu-trigger"))).toBe(false);
    expect(onSignOut).not.toHaveBeenCalled();
    expect(onDeleteAccount).not.toHaveBeenCalled();
  });

  describe("keyboard focus", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // The mocked View's `focus` is what `menuRef.current.focus()` calls.
    function menuFocus(utils: ReturnType<typeof renderMenu>) {
      const [menu] = utils.UNSAFE_root.findAll(
        (node) => node.props.testID === "app-menu" && typeof node.type !== "string",
      );
      const focus = (menu.instance as { focus: jest.Mock }).focus;
      focus.mockClear();
      return focus;
    }

    it("moves keyboard focus to the menu once it has mounted, so Escape reaches it", () => {
      const utils = renderMenu();

      fireEvent.press(utils.getByTestId("app-menu-trigger"));
      const focus = menuFocus(utils);
      expect(focus).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(50);
      });
      expect(focus).toHaveBeenCalledTimes(1);
    });

    it("does not focus a menu that closed before the focus was due", () => {
      const utils = renderMenu();

      fireEvent.press(utils.getByTestId("app-menu-trigger"));
      const focus = menuFocus(utils);
      fireEvent.press(utils.getByTestId("app-menu-trigger"));

      act(() => {
        jest.advanceTimersByTime(50);
      });
      expect(focus).not.toHaveBeenCalled();
    });
  });

  it("opens the menu above the measured anchor section", () => {
    const { getByTestId } = renderMenu();

    fireEvent(getByTestId("anchor"), "layout", {
      nativeEvent: { layout: { x: 0, y: 400, width: 220, height: 52 } },
    });
    fireEvent.press(getByTestId("app-menu-trigger"));

    const menu = getByTestId("app-menu");
    const style = Object.assign({}, ...[menu.props.style].flat(Infinity).filter(Boolean));
    // 52 (anchor height) + spacing.xs gap.
    expect(style).toMatchObject({ position: "absolute", bottom: 56 });
  });

  it("highlights an item on hover and clears it on hover out", () => {
    const { getByTestId } = renderMenu();

    fireEvent.press(getByTestId("app-menu-trigger"));
    const flatStyle = () =>
      Object.assign(
        {},
        ...[getByTestId("logout-button").props.style].flat(Infinity).filter(Boolean),
      ) as { backgroundColor?: string };

    expect(flatStyle().backgroundColor).toBeUndefined();
    fireEvent(getByTestId("logout-button"), "hoverIn");
    expect(flatStyle().backgroundColor).toBeDefined();
    fireEvent(getByTestId("logout-button"), "hoverOut");
    expect(flatStyle().backgroundColor).toBeUndefined();
  });
});
