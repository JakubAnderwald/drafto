import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { DesktopHandoff } from "@/components/auth/desktop-handoff";
import DesktopHandoffPage, { generateStaticParams } from "@/app/(auth)/auth/desktop/[flow]/page";

const mockNotFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
}));

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

interface LocationStub {
  pathname: string;
  search: string;
  hash: string;
  href: string;
}

const originalLocation = window.location;
let location: LocationStub;
let replaceState: ReturnType<typeof vi.spyOn>;

function visit(pathname: string, search = "", hash = "") {
  location = { pathname, search, hash, href: `https://drafto.eu${pathname}${search}${hash}` };
  Object.defineProperty(window, "location", { writable: true, value: location });
}

function onDevice(userAgent: string, maxTouchPoints: number) {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
}

beforeEach(() => {
  replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
  onDevice(MAC_UA, 0);
});

afterEach(() => {
  replaceState.mockRestore();
  Object.defineProperty(window, "location", { writable: true, value: originalLocation });
  // Drop the instance overrides so the prototype getters apply again.
  Reflect.deleteProperty(window.navigator, "userAgent");
  Reflect.deleteProperty(window.navigator, "maxTouchPoints");
});

const openDraftoLink = () => screen.queryByRole("link", { name: "Open Drafto" });

describe("DesktopHandoff — sign-in (callback) on a Mac", () => {
  it("opens the app with the code without claiming sign-in already worked", () => {
    visit("/auth/desktop/callback", "?code=abc&access_token=leak");
    render(<DesktopHandoff flow="callback" />);

    expect(
      screen.getByRole("heading", { name: "Finishing sign-in in Drafto" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Return to Drafto to finish signing in. You can close this tab."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/signed in$/i)).not.toBeInTheDocument();
    expect(openDraftoLink()).toHaveAttribute("href", "eu.drafto.desktop://auth/callback?code=abc");
    expect(location.href).toBe("eu.drafto.desktop://auth/callback?code=abc");
  });

  it("clears the code from the address bar, keeping the history entry's state", () => {
    // Next's router keeps its state on the history entry; replacing it with null breaks back/forward.
    const state = { __NA: true, tree: "next-router-state" };
    const stateGetter = vi.spyOn(window.history, "state", "get").mockReturnValue(state);
    visit("/auth/desktop/callback", "?code=abc");
    render(<DesktopHandoff flow="callback" />);

    expect(replaceState).toHaveBeenCalledWith(state, "", "/auth/desktop/callback");
    stateGetter.mockRestore();
  });

  it("shows fixed copy for a provider error, never the error text from the URL", () => {
    visit(
      "/auth/desktop/callback",
      "?error=access_denied&error_description=Visit+evil.example+to+claim+your+prize",
    );
    render(<DesktopHandoff flow="callback" />);

    expect(screen.getByRole("heading", { name: "Couldn't sign in" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in was cancelled or didn't finish.");
    expect(screen.getByText("Go back to Drafto and try again.")).toBeInTheDocument();
    expect(screen.queryByText(/evil\.example/)).not.toBeInTheDocument();
    // The app still receives the error, so it can react to it.
    expect(openDraftoLink()).toHaveAttribute(
      "href",
      "eu.drafto.desktop://auth/callback?error=access_denied&error_description=Visit+evil.example+to+claim+your+prize",
    );
    expect(location.href).toBe(
      "https://drafto.eu/auth/desktop/callback?error=access_denied&error_description=Visit+evil.example+to+claim+your+prize",
    );
  });

  it("offers no button when there is nothing to hand over", () => {
    visit("/auth/desktop/callback");
    render(<DesktopHandoff flow="callback" />);

    expect(screen.getByTestId("desktop-handoff")).toHaveAttribute("data-state", "empty");
    expect(screen.getByText(/Start signing in from the app/)).toBeInTheDocument();
    expect(openDraftoLink()).not.toBeInTheDocument();
    expect(location.href).toBe("https://drafto.eu/auth/desktop/callback");
  });
});

describe("DesktopHandoff — password reset (recovery) on a Mac", () => {
  it("opens the app on the recovery path and names the same-Mac limit", () => {
    visit("/auth/desktop/recovery", "?code=reset-code");
    render(<DesktopHandoff flow="recovery" />);

    expect(
      screen.getByRole("heading", { name: "Opening Drafto to reset your password" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/only works on the Mac where you asked for the reset/)).toBeVisible();
    expect(location.href).toBe("eu.drafto.desktop://auth/recovery?code=reset-code");
  });

  it("shows fixed expired-link copy for an error in the fragment and forwards it", () => {
    visit(
      "/auth/desktop/recovery",
      "",
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    render(<DesktopHandoff flow="recovery" />);

    expect(
      screen.getByRole("heading", { name: "Couldn't reset your password" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This reset link has expired or was already used.",
    );
    expect(
      screen.getByText("Request a new link from the Drafto app on your Mac."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Email link is invalid/)).not.toBeInTheDocument();
    expect(openDraftoLink()).toHaveAttribute(
      "href",
      "eu.drafto.desktop://auth/recovery?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/desktop/recovery");
  });

  it("explains an incomplete reset link and offers no button", () => {
    visit("/auth/desktop/recovery");
    render(<DesktopHandoff flow="recovery" />);

    expect(
      screen.getByRole("heading", { name: "This reset link is incomplete" }),
    ).toBeInTheDocument();
    expect(openDraftoLink()).not.toBeInTheDocument();
  });
});

describe("DesktopHandoff — off the Mac", () => {
  it.each([
    ["an iPhone", IPHONE_UA, 5],
    ["an iPad in desktop mode", MAC_UA, 5],
  ])("does not launch the app on %s and says the reset belongs on the Mac", (_l, ua, touch) => {
    onDevice(ua, touch);
    visit("/auth/desktop/recovery", "?code=reset-code");
    render(<DesktopHandoff flow="recovery" />);

    expect(screen.getByRole("heading", { name: "Open this link on your Mac" })).toBeInTheDocument();
    expect(
      screen.getByText(/only works on the Mac where you asked for the reset/),
    ).toBeInTheDocument();
    expect(location.href).toBe("https://drafto.eu/auth/desktop/recovery?code=reset-code");
    expect(openDraftoLink()).toHaveAttribute(
      "href",
      "eu.drafto.desktop://auth/recovery?code=reset-code",
    );
  });

  it("does not launch the app for a sign-in either", () => {
    onDevice(IPHONE_UA, 5);
    visit("/auth/desktop/callback", "?code=abc");
    render(<DesktopHandoff flow="callback" />);

    expect(screen.getByTestId("desktop-handoff")).toHaveAttribute("data-state", "not-mac");
    expect(location.href).toBe("https://drafto.eu/auth/desktop/callback?code=abc");
  });
});

describe("DesktopHandoff — Strict Mode", () => {
  it("hands off once, even though effects run twice", () => {
    visit("/auth/desktop/callback", "?code=abc");
    // The second effect run must not rebuild the link from the already-cleared URL.
    replaceState.mockImplementation(() => {
      location.search = "";
    });

    render(
      <StrictMode>
        <DesktopHandoff flow="callback" />
      </StrictMode>,
    );

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(openDraftoLink()).toHaveAttribute("href", "eu.drafto.desktop://auth/callback?code=abc");
  });
});

describe("DesktopHandoffPage", () => {
  it("pre-renders exactly the two flows", () => {
    expect(generateStaticParams()).toEqual([{ flow: "callback" }, { flow: "recovery" }]);
  });

  it("renders the hand-off for a known flow", async () => {
    visit("/auth/desktop/recovery", "?code=abc");
    render(await DesktopHandoffPage({ params: Promise.resolve({ flow: "recovery" }) }));

    expect(screen.getByTestId("desktop-handoff")).toHaveAttribute("data-state", "success");
  });

  it("is a 404 for any other flow", async () => {
    await expect(
      DesktopHandoffPage({ params: Promise.resolve({ flow: "reset-password" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});
