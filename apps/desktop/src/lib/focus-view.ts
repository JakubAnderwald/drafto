import type { ComponentRef } from "react";
import { codegenNativeCommands, type View } from "react-native";

type ViewInstance = ComponentRef<typeof View>;

interface ViewCommands {
  focus: (viewRef: ViewInstance) => void;
}

// The native view's own "focus" command (RCTViewComponentView `handleCommand:`), which makes
// it the window's first responder.
const Commands = codegenNativeCommands<ViewCommands>({ supportedCommands: ["focus"] });

/**
 * Gives a plain view keyboard focus on macOS. `View#focus()` can't be used for that: on
 * react-native-macos 0.83 it does nothing for a non-text view unless the native
 * `enableImperativeFocus` feature flag is on, and it is off by default.
 */
export function focusView(view: ViewInstance | null): void {
  if (view) Commands.focus(view);
}
