import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock localStorage for jsdom
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageStore[key];
  }),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

let ThemeToggle: typeof import("@/components/ui/theme-toggle").ThemeToggle;

describe("ThemeToggle", () => {
  beforeEach(async () => {
    vi.resetModules();
    delete localStorageStore["theme"];
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    document.documentElement.classList.remove("dark");

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const mod = await import("@/components/ui/theme-toggle");
    ThemeToggle = mod.ThemeToggle;
  });

  it("renders with an accessible label", () => {
    render(<ThemeToggle />);
    const button = screen.getByTestId("theme-toggle");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-label");
  });

  it("shows sun icon in light mode", () => {
    render(<ThemeToggle />);
    const button = screen.getByTestId("theme-toggle");
    const svg = button.querySelector("svg");
    expect(svg).toBeInTheDocument();
    // Sun icon has a circle element
    expect(svg?.querySelector("circle")).toBeInTheDocument();
  });

  it("cycles to dark mode on click", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = screen.getByTestId("theme-toggle");

    // Default is system (light), first click goes to light, then dark
    // cycle: light -> dark -> system
    // But default is "system", so first click goes to "light" (next after system in cycle)
    // Wait — cycle is [light, dark, system]. system is index 2, next is index 0 = light
    await user.click(button);
    // Should now be "light" — still shows sun icon
    expect(button).toHaveAttribute("aria-label", "Light mode");

    await user.click(button);
    // Should now be "dark" — shows moon icon
    expect(button).toHaveAttribute("aria-label", "Dark mode");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("cycles back to system after dark", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = screen.getByTestId("theme-toggle");

    // system -> light -> dark -> system
    await user.click(button); // light
    await user.click(button); // dark
    await user.click(button); // system
    expect(button.getAttribute("aria-label")).toContain("System theme");
  });

  it("persists theme to localStorage", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = screen.getByTestId("theme-toggle");
    // system -> light
    await user.click(button);
    expect(localStorage.getItem("theme")).toBe("light");

    // light -> dark
    await user.click(button);
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("applies custom className", () => {
    render(<ThemeToggle className="custom-class" />);
    const button = screen.getByTestId("theme-toggle");
    expect(button.className).toContain("custom-class");
  });
});
