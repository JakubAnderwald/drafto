import React from "react";

import { render, fireEvent } from "../../helpers/test-utils";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("renders the value", () => {
    const { getByDisplayValue } = render(
      <Input value="hello" onChangeText={() => {}} testID="input" />,
    );
    expect(getByDisplayValue("hello")).toBeTruthy();
  });

  it("calls onChangeText when text changes", () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(<Input value="" onChangeText={onChangeText} testID="input" />);
    fireEvent.changeText(getByTestId("input"), "new value");
    expect(onChangeText).toHaveBeenCalledWith("new value");
  });

  it("renders the label when provided", () => {
    const { getByText } = render(
      <Input value="" onChangeText={() => {}} label="Email" testID="input" />,
    );
    expect(getByText("Email")).toBeTruthy();
  });

  it("renders the errorText when provided", () => {
    const { getByText } = render(
      <Input value="" onChangeText={() => {}} errorText="Email is required" testID="input" />,
    );
    expect(getByText("Email is required")).toBeTruthy();
  });

  it("renders the placeholder", () => {
    const { getByPlaceholderText } = render(
      <Input value="" onChangeText={() => {}} placeholder="Enter email" testID="input" />,
    );
    expect(getByPlaceholderText("Enter email")).toBeTruthy();
  });

  it("supports secureTextEntry", () => {
    const { getByTestId } = render(
      <Input value="" onChangeText={() => {}} secureTextEntry testID="pw" />,
    );
    const input = getByTestId("pw");
    expect(input.props.secureTextEntry).toBe(true);
  });

  it("renders left and right icons when provided", () => {
    const { Text } = require("react-native");
    const { getByText } = render(
      <Input
        value=""
        onChangeText={() => {}}
        leftIcon={<Text>L</Text>}
        rightIcon={<Text>R</Text>}
        testID="input"
      />,
    );
    expect(getByText("L")).toBeTruthy();
    expect(getByText("R")).toBeTruthy();
  });
});
