import React from "react";
import { Text } from "react-native";

import { render } from "../../helpers/test-utils";
import { Card } from "../../../src/components/ui/card";

describe("Card", () => {
  it("renders children", () => {
    const { getByText } = render(
      <Card>
        <Text>Hello</Text>
      </Card>,
    );
    expect(getByText("Hello")).toBeTruthy();
  });

  it("renders with testID", () => {
    const { getByTestId } = render(
      <Card testID="card">
        <Text>Hi</Text>
      </Card>,
    );
    expect(getByTestId("card")).toBeTruthy();
  });

  it("accepts different padding sizes without crashing", () => {
    const paddings = ["none", "sm", "md", "lg"] as const;
    paddings.forEach((p) => {
      const { getByText } = render(
        <Card padding={p}>
          <Text>{p}</Text>
        </Card>,
      );
      expect(getByText(p)).toBeTruthy();
    });
  });

  it("applies elevated styling without crashing", () => {
    const { getByText } = render(
      <Card elevated>
        <Text>elevated</Text>
      </Card>,
    );
    expect(getByText("elevated")).toBeTruthy();
  });
});
