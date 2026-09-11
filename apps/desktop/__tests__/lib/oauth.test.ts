const mockExchangeCodeForSession = jest.fn();
const mockSetSession = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      exchangeCodeForSession: (...args: unknown[]) => mockExchangeCodeForSession(...args),
      setSession: (...args: unknown[]) => mockSetSession(...args),
    },
  },
}));

import { handleOAuthCallback } from "../../src/lib/oauth";

describe("handleOAuthCallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    mockSetSession.mockResolvedValue({ data: {}, error: null });
  });

  it("ignores URLs that are not the desktop callback scheme", () => {
    handleOAuthCallback("https://drafto.eu/auth/callback?code=abc");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("exchanges the PKCE code when present in the query string", () => {
    handleOAuthCallback("eu.drafto.desktop://auth/callback?code=pkce-code-123");
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("pkce-code-123");
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("sets the session when implicit-flow tokens arrive in the hash fragment", () => {
    handleOAuthCallback("eu.drafto.desktop://auth/callback#access_token=AAA&refresh_token=RRR");
    expect(mockSetSession).toHaveBeenCalledWith({
      access_token: "AAA",
      refresh_token: "RRR",
    });
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("does nothing when no recognized auth params are present", () => {
    handleOAuthCallback("eu.drafto.desktop://auth/callback");
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("leaves a password-recovery callback for the recovery handler", () => {
    // Both handlers listen on the same scheme. If this one also exchanged the
    // code, the single-use code would be burned and the user would land in the
    // app signed in rather than on the reset screen.
    handleOAuthCallback("eu.drafto.desktop://auth/recovery?code=recovery-code");

    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("leaves a type=recovery callback alone even on the OAuth path", () => {
    handleOAuthCallback(
      "eu.drafto.desktop://auth/callback#access_token=AAA&refresh_token=RRR&type=recovery",
    );

    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
  });
});
