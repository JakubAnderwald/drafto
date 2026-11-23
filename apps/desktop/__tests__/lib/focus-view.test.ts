import type { View } from "react-native";

import { focusView } from "@/lib/focus-view";

jest.mock("react-native", () => {
  const focus = jest.fn();
  return {
    codegenNativeCommands: jest.fn(() => ({ focus })),
    mockCommandFocus: focus,
  };
});

const rn = jest.requireMock<{
  codegenNativeCommands: jest.Mock;
  mockCommandFocus: jest.Mock;
}>("react-native");

describe("focusView", () => {
  it("builds the native view's focus command", () => {
    expect(rn.codegenNativeCommands).toHaveBeenCalledWith({ supportedCommands: ["focus"] });
  });

  it("dispatches it to the view, not View#focus() (a no-op on rnm without a native flag)", () => {
    const view = { focus: jest.fn() } as unknown as View;

    focusView(view);

    expect(rn.mockCommandFocus).toHaveBeenCalledWith(view);
    expect((view as unknown as { focus: jest.Mock }).focus).not.toHaveBeenCalled();
  });

  it("does nothing before the view is mounted", () => {
    rn.mockCommandFocus.mockClear();
    focusView(null);
    expect(rn.mockCommandFocus).not.toHaveBeenCalled();
  });
});
