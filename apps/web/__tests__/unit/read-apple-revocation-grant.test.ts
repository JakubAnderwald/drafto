import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

const { readAppleRevocationGrant } = await import("@/lib/account/read-apple-revocation-grant");

const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const GRANT = { authorizationCode: "c0de", clientId: "eu.drafto.mobile" };

function request(body?: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/account", {
    method: "DELETE",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body,
  });
}

function expectIgnored(reason: string): void {
  expect(captureMessageMock).toHaveBeenCalledWith("Ignored a malformed account deletion body", {
    level: "warning",
    extra: { where: "account-delete:body", userId: USER_ID, reason },
  });
}

describe("readAppleRevocationGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the Apple grant", async () => {
    expect(
      await readAppleRevocationGrant(request(JSON.stringify({ apple: GRANT })), USER_ID),
    ).toEqual(GRANT);
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("drops unknown fields, so the body can never name an account", async () => {
    const body = JSON.stringify({ apple: { ...GRANT, userId: "other" }, userId: "other" });

    expect(await readAppleRevocationGrant(request(body), USER_ID)).toEqual(GRANT);
  });

  it.each([
    ["no body", undefined],
    ["an empty body", ""],
    ["a whitespace body", "  \n"],
    ["a body without a grant", JSON.stringify({ userId: "other" })],
  ])("returns null quietly for %s", async (_label, body) => {
    expect(await readAppleRevocationGrant(request(body), USER_ID)).toBeNull();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("ignores a body that is not JSON", async () => {
    expect(await readAppleRevocationGrant(request("apple=c0de"), USER_ID)).toBeNull();
    expectIgnored("not JSON");
  });

  it.each([
    ["an empty code", { apple: { ...GRANT, authorizationCode: "" } }],
    ["a missing client", { apple: { authorizationCode: "c0de" } }],
    ["a non-string code", { apple: { ...GRANT, authorizationCode: 42 } }],
    ["an oversized code", { apple: { ...GRANT, authorizationCode: "x".repeat(4_097) } }],
    ["a body that is an array", [GRANT]],
  ])("ignores %s and never reports the body", async (_label, body) => {
    expect(await readAppleRevocationGrant(request(JSON.stringify(body)), USER_ID)).toBeNull();
    expectIgnored("invalid Apple grant");
    expect(JSON.stringify(captureMessageMock.mock.calls)).not.toContain("c0de");
  });

  it("ignores a body far larger than a grant without parsing it", async () => {
    const body = JSON.stringify({ apple: GRANT, padding: "x".repeat(20_000) });

    expect(await readAppleRevocationGrant(request(body), USER_ID)).toBeNull();
    expectIgnored("too large");
  });

  it("refuses a declared oversized body before reading it", async () => {
    const getReader = vi.fn();
    const oversized = {
      headers: new Headers({ "content-length": "5000000" }),
      body: { getReader },
    } as unknown as NextRequest;

    expect(await readAppleRevocationGrant(oversized, USER_ID)).toBeNull();
    expect(getReader).not.toHaveBeenCalled();
    expectIgnored("too large");
  });

  it("stops reading, and cancels the stream, once an undeclared body passes the cap", async () => {
    const chunk = new TextEncoder().encode("x".repeat(4_096));
    let pulled = 0;
    const cancel = vi.fn();
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    const request = { headers: new Headers(), body: endless } as unknown as NextRequest;

    expect(await readAppleRevocationGrant(request, USER_ID)).toBeNull();
    expectIgnored("too large");
    expect(cancel).toHaveBeenCalled();
    // 16 KB cap at 4 KB a chunk: the fifth chunk crosses it; nothing much past that is read.
    expect(pulled).toBeLessThanOrEqual(7);
  });

  it("decodes a grant split across chunks, including a multi-byte character", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ apple: { authorizationCode: "c0dé", clientId: "eu.drafto.mobile" } }),
    );
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const request = { headers: new Headers(), body: stream } as unknown as NextRequest;

    expect(await readAppleRevocationGrant(request, USER_ID)).toEqual({
      authorizationCode: "c0dé",
      clientId: "eu.drafto.mobile",
    });
  });

  it("reports a body that cannot be read", async () => {
    const readError = new TypeError("Body is unusable");
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw readError;
      },
    });
    const unreadable = { headers: new Headers(), body: failing } as unknown as NextRequest;

    expect(await readAppleRevocationGrant(unreadable, USER_ID)).toBeNull();
    expect(captureExceptionMock).toHaveBeenCalledWith(readError, {
      extra: { where: "account-delete:readBody", userId: USER_ID },
    });
  });
});
