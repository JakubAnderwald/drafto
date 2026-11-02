import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { ACCOUNT_DELETED_MESSAGE, EMAIL_CONFIRMED } from "@drafto/shared";

// Mock next/navigation
let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

const mockEnterApp = vi.fn();
vi.mock("@/lib/auth/enter-app", () => ({
  enterApp: () => mockEnterApp(),
}));

// Mock Supabase client
const mockSignIn = vi.fn();
const mockSignInWithOAuth = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mockSignIn,
      signInWithOAuth: mockSignInWithOAuth,
    },
  }),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const { default: LoginPage } = await import("@/app/(auth)/login/page");

describe("Login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it("renders the login form with OAuth buttons", async () => {
    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Log In");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apple" })).toBeInTheDocument();
    expect(screen.getByText("or continue with")).toBeInTheDocument();
  });

  it("does not show the account-deleted notice by default", async () => {
    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.queryByText("Your account has been deleted.")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the account-deleted notice after an account deletion redirect", async () => {
    mockSearchParams = new URLSearchParams("deleted=1");

    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Your account has been deleted.");
    // The form stays usable underneath the notice.
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  it("ignores other values of the deleted query parameter", async () => {
    mockSearchParams = new URLSearchParams("deleted=true");

    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.queryByText("Your account has been deleted.")).not.toBeInTheDocument();
  });

  it("shows the account-deleted copy shared with the native apps", async () => {
    mockSearchParams = new URLSearchParams("deleted=1");

    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.getByTestId("account-deleted-notice")).toHaveTextContent(ACCOUNT_DELETED_MESSAGE);
  });

  describe("email-confirmed notice", () => {
    it("confirms the address where the app's sign-up confirmation link lands", async () => {
      // Supabase appends the app's PKCE code; it is meaningless here and must not matter.
      mockSearchParams = new URLSearchParams("confirmed=1&code=app-pkce-code");

      await act(async () => {
        render(<LoginPage />);
      });

      expect(screen.getByRole("status")).toHaveTextContent(EMAIL_CONFIRMED);
      expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    });

    it("ignores other values of the confirmed parameter", async () => {
      mockSearchParams = new URLSearchParams("confirmed=yes");

      await act(async () => {
        render(<LoginPage />);
      });

      expect(screen.queryByText(EMAIL_CONFIRMED)).not.toBeInTheDocument();
    });
  });

  describe("auth-callback error notice", () => {
    it("explains a link the callback could not use", async () => {
      // /auth/callback redirects here when the code exchange fails; the page used to ignore it.
      mockSearchParams = new URLSearchParams("error=auth-callback-error");

      await act(async () => {
        render(<LoginPage />);
      });

      expect(screen.getByRole("alert")).toHaveTextContent("That link couldn't sign you in.");
    });

    it("ignores other error values instead of echoing them", async () => {
      mockSearchParams = new URLSearchParams("error=%3Cscript%3E");

      await act(async () => {
        render(<LoginPage />);
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("gives way to the form's own error once the user tries to log in", async () => {
      mockSearchParams = new URLSearchParams("error=auth-callback-error");
      mockSignIn.mockResolvedValueOnce({ error: { message: "Invalid login credentials" } });
      const user = userEvent.setup();

      await act(async () => {
        render(<LoginPage />);
      });

      await user.type(screen.getByLabelText("Email"), "test@example.com");
      await user.type(screen.getByLabelText("Password"), "wrong");
      await user.click(screen.getByRole("button", { name: "Log in" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
      expect(screen.queryByText(/That link couldn't sign you in/)).not.toBeInTheDocument();
    });
  });

  it("has links to signup and forgot password", async () => {
    await act(async () => {
      render(<LoginPage />);
    });

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("calls signInWithPassword and navigates on success", async () => {
    mockSignIn.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(mockSignIn).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "password123",
    });
    // A full page load, so the router can't reuse the landing page it cached for `/`.
    expect(mockEnterApp).toHaveBeenCalledOnce();
  });

  it("displays error message when sign in fails", async () => {
    mockSignIn.mockResolvedValueOnce({
      error: { message: "Invalid login credentials" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "bad@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
    expect(mockEnterApp).not.toHaveBeenCalled();
  });

  it("shows loading state while submitting", async () => {
    let resolveSignIn: (value: { error: null }) => void;
    mockSignIn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByRole("button", { name: "Logging in..." })).toBeDisabled();

    await act(async () => {
      resolveSignIn!({ error: null });
    });
  });

  it("calls signInWithOAuth when Google button is clicked", async () => {
    mockSignInWithOAuth.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.click(screen.getByRole("button", { name: "Google" }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: expect.stringContaining("/auth/callback") },
    });
  });

  it("calls signInWithOAuth when Apple button is clicked", async () => {
    mockSignInWithOAuth.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.click(screen.getByRole("button", { name: "Apple" }));

    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "apple",
      options: { redirectTo: expect.stringContaining("/auth/callback") },
    });
  });

  it("displays error when OAuth sign-in fails", async () => {
    mockSignInWithOAuth.mockResolvedValueOnce({
      error: { message: "OAuth provider error" },
    });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.click(screen.getByRole("button", { name: "Google" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("OAuth provider error");
  });

  it("clears previous error on new submission", async () => {
    mockSignIn.mockResolvedValueOnce({
      error: { message: "First error" },
    });
    mockSignIn.mockResolvedValueOnce({ error: null });
    const user = userEvent.setup();

    await act(async () => {
      render(<LoginPage />);
    });

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("First error");

    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
