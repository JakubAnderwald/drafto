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

  it("uses the visible-password keyboard on Android while revealed", () => {
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
    const { getByTestId, getByLabelText } = renderField();

    expect(getByTestId("password-input").props.keyboardType).toBeUndefined();
    fireEvent.press(getByLabelText("Show password"));
    expect(getByTestId("password-input").props.keyboardType).toBe("visible-password");
  });

  it("keeps the caller's keyboard on iOS while revealed", () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    const { getByTestId, getByLabelText } = renderField({ keyboardType: "ascii-capable" });

    fireEvent.press(getByLabelText("Show password"));
    expect(getByTestId("password-input").props.keyboardType).toBe("ascii-capable");
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
  });
});
