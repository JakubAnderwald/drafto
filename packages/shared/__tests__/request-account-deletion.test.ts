import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_DELETION_PATH,
  describeAccountDeletionFailure,
  requestAccountDeletion,
} from "../src";

function jsonResponse(status: number, body: unknown) {
  return { status, json: () => Promise.resolve(body) };
}

describe("requestAccountDeletion", () => {
  it("sends a DELETE with the bearer token to the account route", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));

    await requestAccountDeletion({
      baseUrl: "https://drafto.eu/",
      accessToken: "token-123",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(`https://drafto.eu${ACCOUNT_DELETION_PATH}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: "Bearer token-123" },
    });
  });

  it("omits the Authorization header for a same-origin cookie call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));

    await requestAccountDeletion({ baseUrl: "", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("/api/account", {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
  });

  it("returns ok only for a 200 JSON body with success === true", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    await expect(
      requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
    ).resolves.toEqual({ status: "ok" });
  });

  it("maps 401 to unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));
    await expect(
      requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
    ).resolves.toEqual({ status: "unauthorized" });
  });

  it("maps 409 to last-admin", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(409, { error: "Last admin" }));
    await expect(
      requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
    ).resolves.toEqual({ status: "last-admin" });
  });

  it("maps a server error to failed with the HTTP status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    await expect(
      requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
    ).resolves.toEqual({ status: "failed", httpStatus: 500 });
  });

  it("treats a redirected HTML 200 page as failed, not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    });
    await expect(
      requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
    ).resolves.toEqual({ status: "failed", httpStatus: 200 });
  });

  it.each([{ success: false }, { success: "true" }, null, [], "ok"])(
    "treats a 200 body of %j as failed",
    async (body) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
      await expect(
        requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
      ).resolves.toEqual({ status: "failed", httpStatus: 200 });
    },
  );

  it("maps a thrown fetch to network", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    await expect(
      requestAccountDeletion({ baseUrl: "", accessToken: "t", fetchImpl }),
    ).resolves.toEqual({ status: "network" });
  });

  it("falls back to the global fetch when no fetchImpl is given", async () => {
    const globalFetch = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    vi.stubGlobal("fetch", globalFetch);
    try {
      await expect(
        requestAccountDeletion({ baseUrl: "https://drafto.eu", accessToken: "t" }),
      ).resolves.toEqual({
        status: "ok",
      });
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("describeAccountDeletionFailure", () => {
  it.each([
    [{ status: "unauthorized" } as const, /session has expired/],
    [{ status: "last-admin" } as const, /only admin/],
    [{ status: "network" } as const, /connection/],
    [{ status: "failed", httpStatus: 500 } as const, /try again/],
  ])("describes %j", (result, pattern) => {
    expect(describeAccountDeletionFailure(result)).toMatch(pattern);
  });
});

describe("ACCOUNT_DELETE_CONFIRMATION", () => {
  it("is the literal word users must type", () => {
    expect(ACCOUNT_DELETE_CONFIRMATION).toBe("DELETE");
  });
});
