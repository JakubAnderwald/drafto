import React from "react";
import { Text } from "react-native";

import { render, fireEvent } from "../../../helpers/test-utils";
import { Button } from "../../../../src/components/ui/button";

describe("Button", () => {
  it("renders with title", () => {
    const { getByText } = render(<Button title="Save" />);
    expect(getByText("Save")).toBeTruthy();
  });

  it("calls onPress when pressed", () => {
    const onPress = jest.fn();
    const { getByText } = render(<Button title="Press me" onPress={onPress} />);
    fireEvent.press(getByText("Press me"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(["primary", "secondary", "ghost", "danger"] as const)("renders %s variant", (variant) => {
    const { getByText } = render(<Button title="Variant" variant={variant} />);
    expect(getByText("Variant")).toBeTruthy();
  });

  it.each(["sm", "md", "lg"] as const)("renders %s size", (size) => {
    const { getByText } = render(<Button title="Sized" size={size} />);
    expect(getByText("Sized")).toBeTruthy();
  });

  it("does not call onPress when disabled", () => {
    const onPress = jest.fn();
    const { getByText } = render(<Button title="Disabled" onPress={onPress} disabled />);
    fireEvent.press(getByText("Disabled"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("shows ActivityIndicator when loading", () => {
    const { queryByText, UNSAFE_getByType } = render(<Button title="Loading" loading />);
    expect(queryByText("Loading")).toBeNull();
    const ActivityIndicator = require("react-native").ActivityIndicator;
    expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  });

  it("does not call onPress when loading", () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <Button title="Loading" onPress={onPress} loading testID="loading-btn" />,
    );
    fireEvent.press(getByTestId("loading-btn"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("renders leftIcon when provided", () => {
    const { getByText } = render(<Button title="With icon" leftIcon={<Text>ICON</Text>} />);
    expect(getByText("ICON")).toBeTruthy();
    expect(getByText("With icon")).toBeTruthy();
  });

  it("applies testID", () => {
    const { getByTestId } = render(<Button title="Tagged" testID="my-button" />);
    expect(getByTestId("my-button")).toBeTruthy();
  });

  it("uses title as default accessibilityLabel", () => {
    const { getByLabelText } = render(<Button title="Submit" />);
    expect(getByLabelText("Submit")).toBeTruthy();
  });

  it("uses custom accessibilityLabel when provided", () => {
    const { getByLabelText } = render(
      <Button title="Submit" accessibilityLabel="Submit the form" />,
    );
    expect(getByLabelText("Submit the form")).toBeTruthy();
  });
});
