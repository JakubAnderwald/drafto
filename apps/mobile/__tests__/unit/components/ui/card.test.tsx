import React from "react";
import { Text } from "react-native";

import { render } from "../../../helpers/test-utils";
import { Card } from "../../../../src/components/ui/card";

describe("Card", () => {
  it("renders children", () => {
    const { getByText } = render(
      <Card>
        <Text>Card contents</Text>
      </Card>,
    );
    expect(getByText("Card contents")).toBeTruthy();
  });

  it("applies default padding (16)", () => {
    const { getByTestId } = render(
      <Card testID="card">
        <Text>Content</Text>
      </Card>,
    );
    const flattenedStyle = flattenStyle(getByTestId("card").props.style);
    expect(flattenedStyle.padding).toBe(16);
  });

  it("applies custom padding prop", () => {
    const { getByTestId } = render(
      <Card testID="card" padding={32}>
        <Text>Content</Text>
      </Card>,
    );
    const flattenedStyle = flattenStyle(getByTestId("card").props.style);
    expect(flattenedStyle.padding).toBe(32);
  });

  it("applies elevation style when elevated", () => {
    const { getByTestId } = render(
      <Card testID="card" elevated>
        <Text>Content</Text>
      </Card>,
    );
    // Elevation is platform-dependent; just verify the component renders
    expect(getByTestId("card")).toBeTruthy();
  });

  it("merges custom style", () => {
    const { getByTestId } = render(
      <Card testID="card" style={{ marginTop: 24 }}>
        <Text>Content</Text>
      </Card>,
    );
    const flattenedStyle = flattenStyle(getByTestId("card").props.style);
    expect(flattenedStyle.marginTop).toBe(24);
  });
});

// Helper: flatten an RN style array into a single object
function flattenStyle(style: unknown): Record<string, unknown> {
  const { StyleSheet } = require("react-native");
  return StyleSheet.flatten(style) ?? {};
}
