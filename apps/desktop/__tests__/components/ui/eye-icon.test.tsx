import React from "react";

import { render } from "../../helpers/test-utils";
import { EyeIcon } from "@/components/ui/icons/eye-icon";

describe("EyeIcon", () => {
  it("draws an open eye by default at the given size", () => {
    const { getByTestId, queryByTestId } = render(<EyeIcon size={20} color="currentColor" />);

    const root = getByTestId("eye-icon");
    expect(root.props.style).toMatchObject({ width: 20, height: 20 });
    expect(queryByTestId("eye-icon-slash")).toBeNull();
  });

  it("adds the slash when slashed", () => {
    const { getByTestId } = render(<EyeIcon color="currentColor" slashed />);

    expect(getByTestId("eye-icon-slashed").props.style).toMatchObject({ width: 18, height: 18 });
    expect(getByTestId("eye-icon-slash").props.style).toMatchObject({
      transform: [{ rotate: "45deg" }],
    });
  });
});
