import React from "react";

import { render } from "../helpers/test-utils";
import { EmptyState } from "../../src/components/ui/empty-state";

describe("EmptyState", () => {
  it("renders icon and title", () => {
    const { getByText } = render(<EmptyState icon="📝" title="No notes" />);

    expect(getByText("📝")).toBeTruthy();
    expect(getByText("No notes")).toBeTruthy();
  });

  it("renders subtitle when provided", () => {
    const { getByText } = render(
      <EmptyState icon="📝" title="No notes" subtitle="Create your first note" />,
    );

    expect(getByText("Create your first note")).toBeTruthy();
  });

  it("does not render subtitle when not provided", () => {
    const { queryByText } = render(<EmptyState icon="📝" title="No notes" />);

    expect(queryByText("No notes")).toBeTruthy();
    expect(queryByText("Create your first note")).toBeNull();
  });
});
