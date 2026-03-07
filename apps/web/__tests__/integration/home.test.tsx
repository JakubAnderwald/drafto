import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AppPage from "@/app/(app)/page";

describe("App page", () => {
  it("renders without crashing", async () => {
    await act(async () => {
      render(<AppPage />);
    });
    // The app page renders null — all UI comes from the (app) layout's AppShell
    expect(document.body).toBeDefined();
  });
});
