import React from "react";
import { Text } from "react-native";

import { render, fireEvent } from "../../../helpers/test-utils";
import { Input } from "../../../../src/components/ui/input";

describe("Input", () => {
  it("renders with label", () => {
    const { getByText } = render(<Input label="Email" value="" onChangeText={() => {}} />);
    expect(getByText("Email")).toBeTruthy();
  });

  it("renders value", () => {
    const { getByDisplayValue } = render(<Input value="hello@world.com" onChangeText={() => {}} />);
    expect(getByDisplayValue("hello@world.com")).toBeTruthy();
  });

  it("triggers onChangeText when typed", () => {
    const onChangeText = jest.fn();
    const { getByDisplayValue } = render(<Input value="start" onChangeText={onChangeText} />);
    fireEvent.changeText(getByDisplayValue("start"), "typed");
    expect(onChangeText).toHaveBeenCalledWith("typed");
  });

  it("shows errorText when provided", () => {
    const { getByText } = render(
      <Input value="" onChangeText={() => {}} errorText="Email is required" />,
    );
    expect(getByText("Email is required")).toBeTruthy();
  });

  it("does not render error element when errorText is absent", () => {
    const { queryByText } = render(<Input value="" onChangeText={() => {}} />);
    expect(queryByText(/required/i)).toBeNull();
  });

  it("renders leftIcon and rightIcon", () => {
    const { getByText } = render(
      <Input
        value=""
        onChangeText={() => {}}
        leftIcon={<Text>L</Text>}
        rightIcon={<Text>R</Text>}
      />,
    );
    expect(getByText("L")).toBeTruthy();
    expect(getByText("R")).toBeTruthy();
  });

  it("calls onFocus and onBlur callbacks", () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    const { getByDisplayValue } = render(
      <Input value="x" onChangeText={() => {}} onFocus={onFocus} onBlur={onBlur} />,
    );
    const input = getByDisplayValue("x");
    fireEvent(input, "focus");
    expect(onFocus).toHaveBeenCalled();
    fireEvent(input, "blur");
    expect(onBlur).toHaveBeenCalled();
  });

  it("passes secureTextEntry through", () => {
    const { UNSAFE_getByType } = render(<Input value="" onChangeText={() => {}} secureTextEntry />);
    const TextInput = require("react-native").TextInput;
    expect(UNSAFE_getByType(TextInput).props.secureTextEntry).toBe(true);
  });
});
