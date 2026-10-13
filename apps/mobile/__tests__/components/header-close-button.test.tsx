import React from "react";
import { useRouter } from "expo-router";

import { render, fireEvent } from "../helpers/test-utils";
import { HeaderCloseButton } from "@/components/navigation/header-close-button";

describe("HeaderCloseButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is a button labelled Close", () => {
    const { getByLabelText } = render(<HeaderCloseButton testID="sheet-close" />);

    const button = getByLabelText("Close");
    expect(button.props.accessibilityRole).toBe("button");
  });

  it("closes the sheet by going back", () => {
    const back = jest.fn();
    jest.mocked(useRouter).mockReturnValue({ back } as unknown as ReturnType<typeof useRouter>);
    const { getByTestId } = render(<HeaderCloseButton testID="sheet-close" />);

    fireEvent.press(getByTestId("sheet-close"));

    expect(back).toHaveBeenCalledTimes(1);
  });
});
