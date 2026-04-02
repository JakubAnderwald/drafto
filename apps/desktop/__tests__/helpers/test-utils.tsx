import React from "react";
import { render, type RenderOptions } from "@testing-library/react-native";

import { ThemeProvider } from "@/providers/theme-provider";

function AllProviders({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function customRender(ui: React.ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export * from "@testing-library/react-native";
export { customRender as render };
