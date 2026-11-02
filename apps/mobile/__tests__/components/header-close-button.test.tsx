import React from "react";
import { useRouter } from "expo-router";

import { render, fireEvent } from "../helpers/test-utils";
import { HeaderCloseButton } from "@/components/navigation/header-close-button";

function mockRouter(canGoBack: boolean) {
  const router = { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => canGoBack) };
  jest.mocked(useRouter).mockReturnValue(router as unknown as ReturnType<typeof useRouter>);
  return router;
}

describe("HeaderCloseButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is a button labelled Close with a 44 pt tap target", () => {
    mockRouter(true);
    const { getByLabelText } = render(<HeaderCloseButton testID="sheet-close" />);

    const button = getByLabelText("Close");
    expect(button.props.accessibilityRole).toBe("button");
    // 22 pt icon plus 11 pt of slop on each side.
    expect(button.props.hitSlop).toBe(11);
  });

  it("closes the sheet by going back", () => {
    const router = mockRouter(true);
    const { getByTestId } = render(<HeaderCloseButton testID="sheet-close" />);

    fireEvent.press(getByTestId("sheet-close"));

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("goes back only once for a double tap, so the sheet beneath stays open", () => {
    const router = mockRouter(true);
    const { getByTestId } = render(<HeaderCloseButton testID="sheet-close" />);

    fireEvent.press(getByTestId("sheet-close"));
    fireEvent.press(getByTestId("sheet-close"));

    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("opens the app's first screen when the sheet was opened from a link with nothing beneath", () => {
    const router = mockRouter(false);
    const { getByTestId } = render(<HeaderCloseButton testID="sheet-close" />);

    fireEvent.press(getByTestId("sheet-close"));

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});
