import React, { createRef } from "react";
import { Platform, type TextInput } from "react-native";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";

import { render, fireEvent } from "../../../helpers/test-utils";
import { PasswordInput } from "../../../../src/components/ui/password-input";

function renderField(props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) {
  return render(
    <PasswordInput
      label="Password"
      placeholder="Your password"
      value="S01visible42"
      onChangeText={() => {}}
      autoComplete="password"
      textContentType="password"
      testID="password-input"
      {...props}
    />,
  );
}

describe("PasswordInput", () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  });

  it("hides the value by default and offers to show it", () => {
    const { getByTestId, getByLabelText, getByText } = renderField();

    expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
    expect(getByLabelText(PASSWORD_VISIBILITY_LABELS.show)).toBeTruthy();
    expect(getByText("eye-outline")).toBeTruthy();
  });

  it("names the toggle after the field's testID", () => {
    const { getByTestId } = renderField();

    const toggle = getByTestId("password-input-toggle");
    expect(toggle.props.accessibilityRole).toBe("button");
    expect(toggle.props.accessibilityLabel).toBe("Show password");
  });

  it("shows and hides the value when the toggle is pressed", () => {
    const { getByTestId, getByLabelText, getByText } = renderField();

    fireEvent.press(getByLabelText("Show password"));
    expect(getByTestId("password-input").props.secureTextEntry).toBe(false);
    expect(getByLabelText(PASSWORD_VISIBILITY_LABELS.hide)).toBeTruthy();
    expect(getByText("eye-off-outline")).toBeTruthy();

    fireEvent.press(getByLabelText("Hide password"));
    expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
    expect(getByLabelText("Show password")).toBeTruthy();
  });

  it("keeps autofill hints and the value on the same field in both states", () => {
    const { getByTestId, getByLabelText } = renderField();

    const assertField = () => {
      const field = getByTestId("password-input");
      expect(field.props.autoComplete).toBe("password");
      expect(field.props.textContentType).toBe("password");
      expect(field.props.value).toBe("S01visible42");
    };

    assertField();
    fireEvent.press(getByLabelText("Show password"));
    assertField();
  });

  it.each(["android", "ios"] as const)(
    "only flips secureTextEntry on %s, never the keyboard type",
    (os) => {
      Object.defineProperty(Platform, "OS", { value: os, configurable: true });
      const { getByTestId, getByLabelText, rerender } = renderField();

      expect(getByTestId("password-input").props.keyboardType).toBeUndefined();
      fireEvent.press(getByLabelText("Show password"));
      expect(getByTestId("password-input").props.keyboardType).toBeUndefined();

      rerender(
        <PasswordInput
          value="S01visible42"
          onChangeText={() => {}}
          keyboardType="ascii-capable"
          testID="password-input"
        />,
      );
      expect(getByTestId("password-input").props.keyboardType).toBe("ascii-capable");
    },
  );

  describe("hiding the value while the field is focused", () => {
    function renderWithRef() {
      const ref = createRef<TextInput>();
      const utils = render(
        <PasswordInput
          ref={ref}
          value="S01visible42"
          onChangeText={() => {}}
          testID="password-input"
        />,
      );
      // The mocked TextInput shares one blur mock across instances, so count from here.
      const blur = jest.spyOn(ref.current as TextInput, "blur");
      blur.mockClear();
      return { ...utils, blur };
    }

    it("ends the edit on iOS, so UIKit does not wipe the field on the next keystroke", () => {
      Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
      const { getByTestId, blur } = renderWithRef();

      fireEvent(getByTestId("password-input"), "focus");
      fireEvent.press(getByTestId("password-input-toggle"));
      expect(blur).not.toHaveBeenCalled();
      expect(getByTestId("password-input").props.secureTextEntry).toBe(false);

      fireEvent.press(getByTestId("password-input-toggle"));
      expect(blur).toHaveBeenCalledTimes(1);
      expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
    });

    it("leaves focus alone on iOS when the field is not focused", () => {
      Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
      const { getByTestId, blur } = renderWithRef();

      fireEvent(getByTestId("password-input"), "focus");
      fireEvent(getByTestId("password-input"), "blur");
      fireEvent.press(getByTestId("password-input-toggle"));
      fireEvent.press(getByTestId("password-input-toggle"));
      expect(blur).not.toHaveBeenCalled();
    });

    it("leaves focus alone on Android", () => {
      Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
      const { getByTestId, blur } = renderWithRef();

      fireEvent(getByTestId("password-input"), "focus");
      fireEvent.press(getByTestId("password-input-toggle"));
      fireEvent.press(getByTestId("password-input-toggle"));
      expect(blur).not.toHaveBeenCalled();
      expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
    });
  });

  it("passes focus and blur through to the caller", () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    const { getByTestId } = renderField({ onFocus, onBlur });

    fireEvent(getByTestId("password-input"), "focus");
    fireEvent(getByTestId("password-input"), "blur");
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("disables the toggle while the field is not editable", () => {
    const { getByTestId, getByLabelText } = renderField({ editable: false });

    fireEvent.press(getByLabelText("Show password"));
    expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
  });

  it("has no toggle testID when the field has none", () => {
    const { queryByTestId, getByLabelText } = renderField({ testID: undefined });

    expect(getByLabelText("Show password")).toBeTruthy();
    expect(queryByTestId("undefined-toggle")).toBeNull();
  });

  it("forwards its ref to the TextInput", () => {
    const ref = createRef<TextInput>();
    render(<PasswordInput ref={ref} value="" onChangeText={() => {}} />);

    expect(ref.current).toBeTruthy();
    expect(typeof ref.current?.focus).toBe("function");
  });

  it("forwards a callback ref", () => {
    const ref = jest.fn();
    render(<PasswordInput ref={ref} value="" onChangeText={() => {}} />);

    expect(ref).toHaveBeenCalledWith(expect.objectContaining({ focus: expect.any(Function) }));
  });
});
