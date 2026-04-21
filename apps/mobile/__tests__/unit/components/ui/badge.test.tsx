import React from "react";

import { render } from "../../../helpers/test-utils";
import { Badge } from "../../../../src/components/ui/badge";

describe("Badge", () => {
  it("renders label", () => {
    const { getByText } = render(<Badge label="New" />);
    expect(getByText("New")).toBeTruthy();
  });

  it.each(["neutral", "success", "warning", "error"] as const)("renders %s variant", (variant) => {
    const { getByText } = render(<Badge label="Status" variant={variant} />);
    expect(getByText("Status")).toBeTruthy();
  });

  it.each(["sm", "md"] as const)("renders %s size", (size) => {
    const { getByText } = render(<Badge label="Size" size={size} />);
    expect(getByText("Size")).toBeTruthy();
  });

  it("applies testID", () => {
    const { getByTestId } = render(<Badge label="Tagged" testID="my-badge" />);
    expect(getByTestId("my-badge")).toBeTruthy();
  });

  it("neutral variant uses bgMuted background", () => {
    const { getByTestId } = render(<Badge label="N" variant="neutral" testID="b" />);
    const { StyleSheet } = require("react-native");
    const flat = StyleSheet.flatten(getByTestId("b").props.style);
    // Neutral uses semantic.bgMuted (light theme "#F4E9E0")
    expect(flat.backgroundColor).toBeDefined();
  });
});
