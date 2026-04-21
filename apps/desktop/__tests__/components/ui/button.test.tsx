import React from "react";

import { render, fireEvent } from "../../helpers/test-utils";
import { Button } from "../../../src/components/ui/button";

describe("Button", () => {
  it("renders the title", () => {
    const { getByText } = render(<Button title="Save" onPress={() => {}} />);
    expect(getByText("Save")).toBeTruthy();
  });

  it("calls onPress when pressed", () => {
    const onPress = jest.fn();
    const { getByText } = render(<Button title="Click" onPress={onPress} />);
    fireEvent.press(getByText("Click"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not call onPress when disabled", () => {
    const onPress = jest.fn();
    const { getByText } = render(<Button title="Click" onPress={onPress} disabled />);
    fireEvent.press(getByText("Click"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("renders a loading indicator and hides the title when loading", () => {
    const { queryByText, UNSAFE_getAllByType } = render(
      <Button title="Save" onPress={() => {}} loading />,
    );
    expect(queryByText("Save")).toBeNull();

    // ActivityIndicator is present
    const { ActivityIndicator } = require("react-native");
    expect(UNSAFE_getAllByType(ActivityIndicator).length).toBeGreaterThan(0);
  });

  it("does not call onPress when loading", () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <Button title="Save" onPress={onPress} loading testID="save-btn" />,
    );
    fireEvent.press(getByTestId("save-btn"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("renders all variants without crashing", () => {
    const variants = ["primary", "secondary", "ghost", "danger"] as const;
    variants.forEach((variant) => {
      const { getByText } = render(<Button title={variant} variant={variant} onPress={() => {}} />);
      expect(getByText(variant)).toBeTruthy();
    });
  });

  it("renders all sizes without crashing", () => {
    const sizes = ["sm", "md", "lg"] as const;
    sizes.forEach((size) => {
      const { getByText } = render(<Button title={size} size={size} onPress={() => {}} />);
      expect(getByText(size)).toBeTruthy();
    });
  });

  it("renders a left icon when provided", () => {
    const { Text } = require("react-native");
    const { getByText } = render(
      <Button title="Save" onPress={() => {}} leftIcon={<Text>★</Text>} />,
    );
    expect(getByText("★")).toBeTruthy();
    expect(getByText("Save")).toBeTruthy();
  });

  it("applies testID for targeting in tests", () => {
    const { getByTestId } = render(<Button title="Save" onPress={() => {}} testID="save-button" />);
    expect(getByTestId("save-button")).toBeTruthy();
  });
});
