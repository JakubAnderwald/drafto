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

  it("focuses the field again after a toggle, since macOS swaps the native view", () => {
    const ref = createRef<TextInput>();
    const { getByTestId } = render(
      <PasswordInput ref={ref} value="" onChangeText={() => {}} testID="password-input" />,
    );
    expect(ref.current).toBeTruthy();
    // The mocked TextInput shares one focus mock across instances, so count from here.
    const focus = jest.spyOn(ref.current as TextInput, "focus");
    focus.mockClear();

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(focus).toHaveBeenCalledTimes(1);

    fireEvent.press(getByTestId("password-input-toggle"));
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("does not grab focus without a toggle", () => {
    const ref = createRef<TextInput>();
    const { rerender } = render(<PasswordInput ref={ref} value="" onChangeText={() => {}} />);
    const focus = jest.spyOn(ref.current as TextInput, "focus");
    focus.mockClear();

    rerender(<PasswordInput ref={ref} value="typed" onChangeText={() => {}} />);
    expect(focus).not.toHaveBeenCalled();
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
