import React from "react";

import { render } from "../../helpers/test-utils";
import { Badge } from "@/components/ui/badge";

describe("Badge", () => {
  it("renders the label", () => {
    const { getByText } = render(<Badge label="Synced" />);
    expect(getByText("Synced")).toBeTruthy();
  });

  it("renders all variants without crashing", () => {
    const variants = ["neutral", "success", "warning", "error"] as const;
    variants.forEach((variant) => {
      const { getByText } = render(<Badge label={variant} variant={variant} />);
      expect(getByText(variant)).toBeTruthy();
    });
  });

  it("applies testID", () => {
    const { getByTestId } = render(<Badge label="Pending" testID="pending-badge" />);
    expect(getByTestId("pending-badge")).toBeTruthy();
  });
});
