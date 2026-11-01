import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
}));

const mockSignOut = vi.fn();
const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signOut: mockSignOut, getUser: mockGetUser },
  }),
}));

let mockOrigin = "http://localhost:3000";
vi.mock("@/hooks/use-page-origin", () => ({
  usePageOrigin: () => mockOrigin,
}));

const mockLoadAppleIdAuth = vi.fn();
const mockGetLoadedAppleIdAuth = vi.fn();
vi.mock("@/lib/apple/apple-js", () => ({
  loadAppleIdAuth: () => mockLoadAppleIdAuth(),
  getLoadedAppleIdAuth: () => mockGetLoadedAppleIdAuth(),
}));

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

const { DeleteAccountSection } = await import("@/components/settings/delete-account-section");

const WARNING =
  "This permanently deletes your Drafto account and all of your notebooks, notes and attachments. This cannot be undone.";

const APPLE_NOTICE =
  "You use Sign in with Apple, so Apple will ask you to confirm in a pop-up window. This lets Drafto stop using your Apple ID. If you cancel that step, your account is still deleted.";
const APPLE_CODE = "c1a2b3.0.abcd.EfGh-IjKl_MnOp";
const APPLE_USER = {
  id: "apple-user",
  identities: [{ provider: "apple" }],
  app_metadata: { providers: ["apple"] },
};
const PASSWORD_USER = {
  id: "password-user",
  identities: [{ provider: "email" }],
  app_metadata: { providers: ["email"] },
};

interface FakeAppleInit {
  state: string;
}

/** A fake `AppleID.auth` whose popup answers with `respond(state)`. */
function fakeAppleApi(respond: (state: string) => Promise<unknown>) {
  let state = "";
  const init = vi.fn((options: FakeAppleInit) => {
    state = options.state;
  });
  const signIn = vi.fn(() => respond(state));
  return { init, signIn };
}

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Delete account" }));
  return screen.getByRole("alertdialog", { name: "Delete your account?" });
}

function confirmButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Delete account" });
}

describe("DeleteAccountSection", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockSignOut.mockResolvedValue({ error: null });
    mockOrigin = "http://localhost:3000";
    mockGetUser.mockResolvedValue({ data: { user: PASSWORD_USER }, error: null });
    mockLoadAppleIdAuth.mockResolvedValue(null);
    mockGetLoadedAppleIdAuth.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the section heading, warning and a danger button", () => {
    render(<DeleteAccountSection />);

    expect(screen.getByRole("heading", { name: "Delete account" })).toBeInTheDocument();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Delete account" });
    expect(button.className).toContain("bg-error");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("merges a custom className onto the card", () => {
    render(<DeleteAccountSection className="mt-6" />);
    expect(screen.getByTestId("delete-account-section").className).toContain("mt-6");
  });

  it("opens a confirmation dialog with the warning and the typed confirmation input", async () => {
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(WARNING)).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Type DELETE to confirm");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(confirmButton(dialog)).toBeDisabled();
  });

  it.each(["", "delete", "DELET", "Delete", "DELETE!", "DE LETE"])(
    "keeps confirm disabled for %j",
    async (typed) => {
      const user = userEvent.setup();
      render(<DeleteAccountSection />);
      const dialog = await openDialog(user);

      if (typed) await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), typed);

      expect(confirmButton(dialog)).toBeDisabled();
    },
  );

  it.each(["DELETE", " DELETE "])("enables confirm for %j", async (typed) => {
    const user = userEvent.setup();
    render(<DeleteAccountSection />);
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), typed);

    expect(confirmButton(dialog)).toBeEnabled();
  });

  it("cancel closes the dialog and resets the typed text and error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    let dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(confirmButton(dialog));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    dialog = await openDialog(user);
    expect(within(dialog).getByLabelText("Type DELETE to confirm")).toHaveValue("");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(confirmButton(dialog)).toBeDisabled();
  });

  it("on success deletes via the API, signs out locally and redirects to the login notice", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(confirmButton(dialog));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/account");
    expect(init.method).toBe("DELETE");
    // Cookie auth on web: no bearer token and no user id in the request.
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mockSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      mockReplace.mock.invocationCallOrder[0],
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("shows the loading state and disables the input while the request is pending", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);
    const input = within(dialog).getByLabelText("Type DELETE to confirm");
    await user.type(input, "DELETE");
    await user.click(confirmButton(dialog));

    expect(confirmButton(dialog)).toBeDisabled();
    expect(input).toBeDisabled();

    // Cancel is ignored while the request is in flight, so its outcome stays visible.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    resolveFetch(jsonResponse(409, { error: "last admin" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(input).toBeEnabled();
  });

  it.each([
    {
      name: "last admin (409)",
      response: () => Promise.resolve(jsonResponse(409, { error: "Conflict" })),
      copy: "You are the only admin. Make another user an admin before deleting your account.",
    },
    {
      name: "unauthorized (401)",
      response: () => Promise.resolve(jsonResponse(401, { error: "Unauthorized" })),
      copy: "Your session has expired. Sign out, sign back in, and try again.",
    },
    {
      name: "server error (500)",
      response: () => Promise.resolve(jsonResponse(500, { error: "Internal" })),
      copy: "Something went wrong while deleting your account. Please try again.",
    },
    {
      name: "redirected HTML page (200 without success)",
      response: () =>
        Promise.resolve({ status: 200, ok: true, json: () => Promise.reject(new Error("html")) }),
      copy: "Something went wrong while deleting your account. Please try again.",
    },
    {
      name: "network failure",
      response: () => Promise.reject(new TypeError("Failed to fetch")),
      copy: "Couldn't reach Drafto. Check your connection and try again.",
    },
  ])("on $name shows the error and does not sign out or redirect", async ({ response, copy }) => {
    mockFetch.mockImplementationOnce(response);
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(confirmButton(dialog));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(copy);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    // The user can retry straight away.
    expect(confirmButton(dialog)).toBeEnabled();
  });

  it("clears the previous error when retrying", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, {}));
    let resolveRetry: (value: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(confirmButton(dialog));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();

    await user.click(confirmButton(dialog));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();

    resolveRetry(jsonResponse(200, { success: true }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
  });

  it("still redirects and reports to Sentry when sign-out returns an error", async () => {
    const signOutError = new Error("sign-out failed");
    mockSignOut.mockResolvedValueOnce({ error: signOutError });
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(confirmButton(dialog));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
    expect(captureExceptionMock).toHaveBeenCalledWith(
      signOutError,
      expect.objectContaining({ extra: { where: "delete-account-section:signOut" } }),
    );
  });

  it("still redirects and reports to Sentry when sign-out throws", async () => {
    const thrown = new Error("storage unavailable");
    mockSignOut.mockRejectedValueOnce(thrown);
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const user = userEvent.setup();
    render(<DeleteAccountSection />);

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(confirmButton(dialog));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
    expect(captureExceptionMock).toHaveBeenCalledWith(
      thrown,
      expect.objectContaining({ extra: { where: "delete-account-section:signOut" } }),
    );
  });
  describe("Sign in with Apple step", () => {
    async function typeAndConfirm(user: ReturnType<typeof userEvent.setup>) {
      const dialog = await openDialog(user);
      await within(dialog).findByTestId("delete-account-apple-notice");
      await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
      await user.click(confirmButton(dialog));
      return dialog;
    }

    beforeEach(() => {
      mockOrigin = "https://drafto.eu";
      mockGetUser.mockResolvedValue({ data: { user: APPLE_USER }, error: null });
    });

    it("shows the pop-up notice and preloads Apple's script for an Apple-linked user on drafto.eu", async () => {
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      const dialog = await openDialog(user);

      expect(await within(dialog).findByText(APPLE_NOTICE)).toBeInTheDocument();
      await waitFor(() => expect(mockLoadAppleIdAuth).toHaveBeenCalled());
    });

    it("forwards Apple's code with the deletion", async () => {
      const api = fakeAppleApi((state) =>
        Promise.resolve({ authorization: { code: APPLE_CODE, state } }),
      );
      mockGetLoadedAppleIdAuth.mockReturnValue(api);
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      await typeAndConfirm(user);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
      expect(api.init).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: "eu.drafto.web.auth", usePopup: true }),
      );
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("/api/account");
      expect(init.method).toBe("DELETE");
      expect(JSON.parse(init.body)).toEqual({
        apple: { authorizationCode: APPLE_CODE, clientId: "eu.drafto.web.auth" },
      });
      expect(api.signIn.mock.invocationCallOrder[0]).toBeLessThan(
        mockFetch.mock.invocationCallOrder[0],
      );
    });

    it("still deletes, without a grant, when the popup is closed", async () => {
      mockGetLoadedAppleIdAuth.mockReturnValue(
        fakeAppleApi(() => Promise.reject({ error: "popup_closed_by_user" })),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      await typeAndConfirm(user);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    });

    it("still deletes, without a grant, when Apple's script never loaded", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      await typeAndConfirm(user);

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    });

    it("aborts with the session copy when a different user is signed in after the Apple step", async () => {
      mockGetLoadedAppleIdAuth.mockReturnValue(
        fakeAppleApi((state) => Promise.resolve({ authorization: { code: APPLE_CODE, state } })),
      );
      mockGetUser
        .mockResolvedValueOnce({ data: { user: APPLE_USER }, error: null })
        .mockResolvedValue({
          data: { user: { ...PASSWORD_USER, id: "someone-else" } },
          error: null,
        });
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      const dialog = await typeAndConfirm(user);

      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Your session has expired. Sign out, sign back in, and try again.",
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it("shows no Apple step for a user without Sign in with Apple", async () => {
      mockGetUser.mockResolvedValue({ data: { user: PASSWORD_USER }, error: null });
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      const dialog = await openDialog(user);
      await waitFor(() => expect(mockGetUser).toHaveBeenCalled());
      expect(within(dialog).queryByText(APPLE_NOTICE)).not.toBeInTheDocument();
      await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
      await user.click(confirmButton(dialog));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
      expect(mockGetLoadedAppleIdAuth).not.toHaveBeenCalled();
      expect(mockLoadAppleIdAuth).not.toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    });

    it.each([
      "http://localhost:3000",
      "https://drafto-git-feature-jakubanderwalds-projects.vercel.app",
    ])("skips the Apple step for an Apple-linked user on %s", async (origin) => {
      mockOrigin = origin;
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { success: true }));
      const user = userEvent.setup();
      render(<DeleteAccountSection />);

      const dialog = await openDialog(user);
      expect(within(dialog).queryByText(APPLE_NOTICE)).not.toBeInTheDocument();
      await user.type(within(dialog).getByLabelText("Type DELETE to confirm"), "DELETE");
      await user.click(confirmButton(dialog));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/login?deleted=1"));
      expect(mockGetUser).not.toHaveBeenCalled();
      expect(mockLoadAppleIdAuth).not.toHaveBeenCalled();
      expect(mockGetLoadedAppleIdAuth).not.toHaveBeenCalled();
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    });
  });
});
