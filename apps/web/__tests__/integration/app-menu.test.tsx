import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppMenu } from "@/components/layout/app-menu";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// The order logout steps run in: pending autosaves must flush before signOut clears the
// session cookie.
const logoutSteps: string[] = [];

const mockFlushPendingSaves = vi.fn(async () => {
  logoutSteps.push("flush");
});
vi.mock("@/lib/pending-saves", () => ({
  flushPendingSaves: () => mockFlushPendingSaves(),
}));

// Mock Supabase client
const mockSignOut = vi.fn(async () => {
  logoutSteps.push("signOut");
  return { error: null };
});
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: mockSignOut },
  }),
}));

describe("AppMenu", () => {
  const mockOnImportEvernote = vi.fn();
  const mockOnImportTickTick = vi.fn();
  const mockOnExportEvernote = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    logoutSteps.length = 0;
  });

  it("renders the menu trigger and theme toggle", () => {
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    expect(screen.getByTestId("app-menu-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("opens dropdown when trigger is clicked", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));

    expect(screen.getByTestId("import-evernote-button")).toBeInTheDocument();
    expect(screen.getByTestId("logout-button")).toBeInTheDocument();
  });

  it("calls onImportEvernote when import button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));
    await user.click(screen.getByTestId("import-evernote-button"));

    expect(mockOnImportEvernote).toHaveBeenCalled();
  });

  it("calls onImportTickTick when TickTick import button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));
    await user.click(screen.getByTestId("import-ticktick-button"));

    expect(mockOnImportTickTick).toHaveBeenCalled();
  });

  it("calls onExportEvernote when export button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));
    await user.click(screen.getByTestId("export-evernote-button"));

    expect(mockOnExportEvernote).toHaveBeenCalled();
  });

  it("does not render Admin link when isAdmin is false", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );
    await user.click(screen.getByTestId("app-menu-trigger"));
    expect(screen.queryByTestId("admin-button")).not.toBeInTheDocument();
  });

  it("renders Admin link and navigates when isAdmin is true", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
        isAdmin
      />,
    );
    await user.click(screen.getByTestId("app-menu-trigger"));

    const adminButton = screen.getByTestId("admin-button");
    expect(adminButton).toBeInTheDocument();

    await user.click(adminButton);
    expect(mockPush).toHaveBeenCalledWith("/admin");
  });

  it("waits for pending saves to flush, then calls signOut and redirects on logout", async () => {
    const user = userEvent.setup();

    // Mock window.location
    const locationMock = { href: "" };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
    });

    // The flush stays in flight until the test finishes it.
    let finishFlush: () => void = () => {};
    mockFlushPendingSaves.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          logoutSteps.push("flush");
          finishFlush = resolve;
        }),
    );

    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));
    await user.click(screen.getByTestId("logout-button"));

    // Sign-out waits while the flush is still running.
    await vi.waitFor(() => {
      expect(mockFlushPendingSaves).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(locationMock.href).toBe("");

    finishFlush();
    await vi.waitFor(() => {
      expect(locationMock.href).toBe("/login");
    });
    expect(mockSignOut).toHaveBeenCalled();
    expect(logoutSteps).toEqual(["flush", "signOut"]);
  });

  it("closes on a second trigger click and stays closed", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );
    const trigger = screen.getByTestId("app-menu-trigger");

    await user.click(trigger);
    expect(screen.getByTestId("import-evernote-button")).toBeInTheDocument();

    // Before the fix, the trigger's mousedown closed the menu and its click reopened it.
    await user.click(trigger);
    expect(screen.queryByTestId("import-evernote-button")).not.toBeInTheDocument();
    // Let any queued work run; the menu must not come back on its own.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("import-evernote-button")).not.toBeInTheDocument();
  });

  it("reopens on a third trigger click", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );
    const trigger = screen.getByTestId("app-menu-trigger");

    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByTestId("import-evernote-button")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByTestId("import-evernote-button")).toBeInTheDocument();
  });

  it("closes when clicking outside the menu", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));
    expect(screen.getByTestId("import-evernote-button")).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByTestId("import-evernote-button")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <AppMenu
        onImportEvernote={mockOnImportEvernote}
        onImportTickTick={mockOnImportTickTick}
        onExportEvernote={mockOnExportEvernote}
      />,
    );

    await user.click(screen.getByTestId("app-menu-trigger"));
    expect(screen.getByTestId("import-evernote-button")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("import-evernote-button")).not.toBeInTheDocument();
  });
});
