import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppMenu } from "@/components/layout/app-menu";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock Supabase client
const mockSignOut = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: mockSignOut },
  }),
}));

describe("AppMenu", () => {
  const mockOnImportEvernote = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the menu trigger and theme toggle", () => {
    render(<AppMenu onImportEvernote={mockOnImportEvernote} />);

    expect(screen.getByTestId("app-menu-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("opens dropdown when trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<AppMenu onImportEvernote={mockOnImportEvernote} />);

    await user.click(screen.getByTestId("app-menu-trigger"));

    expect(screen.getByTestId("import-evernote-button")).toBeInTheDocument();
    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("calls onImportEvernote when import button is clicked", async () => {
    const user = userEvent.setup();
    render(<AppMenu onImportEvernote={mockOnImportEvernote} />);

    await user.click(screen.getByTestId("app-menu-trigger"));
    await user.click(screen.getByTestId("import-evernote-button"));

    expect(mockOnImportEvernote).toHaveBeenCalled();
  });

  it("does not render Admin link when isAdmin is false", async () => {
    const user = userEvent.setup();
    render(<AppMenu onImportEvernote={mockOnImportEvernote} />);
    await user.click(screen.getByTestId("app-menu-trigger"));
    expect(screen.queryByTestId("admin-button")).not.toBeInTheDocument();
  });

  it("renders Admin link and navigates when isAdmin is true", async () => {
    const user = userEvent.setup();
    render(<AppMenu onImportEvernote={mockOnImportEvernote} isAdmin />);
    await user.click(screen.getByTestId("app-menu-trigger"));

    const adminButton = screen.getByTestId("admin-button");
    expect(adminButton).toBeInTheDocument();

    await user.click(adminButton);
    expect(mockPush).toHaveBeenCalledWith("/admin");
  });

  it("calls signOut and redirects on logout", async () => {
    const user = userEvent.setup();

    // Mock window.location
    const locationMock = { href: "" };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
    });

    render(<AppMenu onImportEvernote={mockOnImportEvernote} />);

    await user.click(screen.getByTestId("app-menu-trigger"));
    await user.click(screen.getByTestId("logout-button"));

    expect(mockSignOut).toHaveBeenCalled();
    // Wait for async signOut to complete
    await vi.waitFor(() => {
      expect(locationMock.href).toBe("/login");
    });
  });
});
