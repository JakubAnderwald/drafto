import React, { createRef } from "react";
import type { TextInput } from "react-native";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";

import { render, fireEvent } from "../../helpers/test-utils";
import { PasswordInput } from "@/components/ui/password-input";

function renderField(props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) {
  return render(
    <PasswordInput
      label="Password"
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
  it("hides the value by default and offers to show it", () => {
    const { getByTestId, queryByTestId } = renderField();

    expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
    const toggle = getByTestId("password-input-toggle");
    expect(toggle.props.accessibilityLabel).toBe(PASSWORD_VISIBILITY_LABELS.show);
    expect(toggle.props.accessibilityRole).toBe("button");
    expect(getByTestId("eye-icon")).toBeTruthy();
    expect(queryByTestId("eye-icon-slash")).toBeNull();
  });

  it("shows and hides the value when the toggle is pressed", () => {
    const { getByTestId, getByLabelText } = renderField();

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(getByTestId("password-input").props.secureTextEntry).toBe(false);
    expect(getByLabelText(PASSWORD_VISIBILITY_LABELS.hide)).toBeTruthy();
    expect(getByTestId("eye-icon-slashed")).toBeTruthy();
    expect(getByTestId("eye-icon-slash")).toBeTruthy();

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
    expect(getByLabelText("Show password")).toBeTruthy();
  });

  it("keeps autofill hints, the label and the value on the same field in both states", () => {
    const { getByTestId } = renderField();

    const assertField = () => {
      const field = getByTestId("password-input");
      expect(field.props.autoComplete).toBe("password");
      expect(field.props.textContentType).toBe("password");
      expect(field.props.accessibilityLabel).toBe("Password");
      expect(field.props.value).toBe("S01visible42");
    };

    assertField();
    fireEvent.press(getByTestId("password-input-toggle"));
    assertField();
  });

  describe("focus after a toggle", () => {
    function renderWithRef(value = "S01visible42") {
      const ref = createRef<TextInput>();
      const utils = render(
        <PasswordInput ref={ref} value={value} onChangeText={() => {}} testID="password-input" />,
      );
      expect(ref.current).toBeTruthy();
      const field = ref.current as TextInput;
      // The mocked TextInput shares one focus / setSelection mock across instances, so count
      // from here.
      const focus = jest.spyOn(field, "focus");
      const setSelection = jest.spyOn(field, "setSelection");
      focus.mockClear();
      setSelection.mockClear();
      return { ...utils, focus, setSelection };
    }

    it("focuses the field again, caret at the end, when it had focus (macOS swaps the native view)", () => {
      const { getByTestId, focus, setSelection } = renderWithRef();

      fireEvent(getByTestId("password-input"), "focus");
      fireEvent.press(getByTestId("password-input-toggle"));
      expect(focus).toHaveBeenCalledTimes(1);
      // AppKit selects the whole field on focus; a collapsed selection at the end means the
      // next keystroke appends instead of replacing the password.
      expect(setSelection).toHaveBeenCalledTimes(1);
      expect(setSelection).toHaveBeenLastCalledWith(12, 12);
      expect(focus.mock.invocationCallOrder[0]).toBeLessThan(
        setSelection.mock.invocationCallOrder[0],
      );

      fireEvent.press(getByTestId("password-input-toggle"));
      expect(focus).toHaveBeenCalledTimes(2);
      expect(setSelection).toHaveBeenCalledTimes(2);
    });

    it("leaves focus on the toggle when the field did not have it", () => {
      const { getByTestId, focus, setSelection } = renderWithRef();

      fireEvent.press(getByTestId("password-input-toggle"));
      expect(getByTestId("password-input").props.secureTextEntry).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(setSelection).not.toHaveBeenCalled();
    });

    it("leaves focus alone once the field has lost it (keyboard or VoiceOver on the toggle)", () => {
      const { getByTestId, focus } = renderWithRef();

      fireEvent(getByTestId("password-input"), "focus");
      fireEvent(getByTestId("password-input"), "blur");
      fireEvent.press(getByTestId("password-input-toggle"));
      fireEvent.press(getByTestId("password-input-toggle"));
      expect(focus).not.toHaveBeenCalled();
    });

    it("puts the caret at 0 in an empty field", () => {
      const { getByTestId, setSelection } = renderWithRef("");

      fireEvent(getByTestId("password-input"), "focus");
      fireEvent.press(getByTestId("password-input-toggle"));
      expect(setSelection).toHaveBeenLastCalledWith(0, 0);
    });

    it("does not grab focus without a toggle", () => {
      const ref = createRef<TextInput>();
      const { rerender, getByTestId } = render(
        <PasswordInput ref={ref} value="" onChangeText={() => {}} testID="password-input" />,
      );
      const focus = jest.spyOn(ref.current as TextInput, "focus");
      focus.mockClear();

      fireEvent(getByTestId("password-input"), "focus");
      rerender(
        <PasswordInput ref={ref} value="typed" onChangeText={() => {}} testID="password-input" />,
      );
      expect(focus).not.toHaveBeenCalled();
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

  it("forwards a callback ref", () => {
    const ref = jest.fn();
    render(<PasswordInput ref={ref} value="" onChangeText={() => {}} />);
    expect(ref).toHaveBeenCalledWith(expect.anything());
  });

  it("disables the toggle while the field is not editable", () => {
    const { getByTestId } = renderField({ editable: false });

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(getByTestId("password-input").props.secureTextEntry).toBe(true);
  });

  it("has no toggle testID when the field has none", () => {
    const { getByLabelText, queryByTestId } = renderField({ testID: undefined });

    expect(getByLabelText("Show password")).toBeTruthy();
    expect(queryByTestId("undefined-toggle")).toBeNull();
  });
});
