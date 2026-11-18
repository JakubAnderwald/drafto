import React from "react";
import { Text } from "react-native";

import { render, fireEvent } from "../../helpers/test-utils";
import { IconButton } from "@/components/ui/icon-button";

describe("IconButton", () => {
  it("calls onPress and exposes its accessible name", () => {
    const onPress = jest.fn();
    const { getByLabelText } = render(
      <IconButton onPress={onPress} accessibilityLabel="Search" testID="search">
        <Text>S</Text>
      </IconButton>,
    );

    fireEvent.press(getByLabelText("Search"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("ignores presses and reports disabled when disabled", () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <IconButton onPress={onPress} accessibilityLabel="Search" testID="search" disabled>
        <Text>S</Text>
      </IconButton>,
    );

    fireEvent.press(getByTestId("search"));
    expect(onPress).not.toHaveBeenCalled();
    expect(getByTestId("search").props.accessibilityState).toMatchObject({ disabled: true });
  });
});
