import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";

// `commit` comes from `VERCEL_GIT_COMMIT_SHA` through `@/env`; each case sets it on this object.
const mockEnv = vi.hoisted(() => ({
  VERCEL_GIT_COMMIT_SHA: undefined as string | undefined,
}));
vi.mock("@/env", () => ({ env: mockEnv }));

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("GET /api/health", () => {
  beforeEach(() => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = undefined;
  });

  it("returns status ok with a timestamp", async () => {
    const response = GET();
    const body = await response.json();

    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("returns the deployment's commit SHA when VERCEL_GIT_COMMIT_SHA is set", async () => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = SHA;

    const body = await GET().json();

    expect(body).toEqual({ status: "ok", timestamp: expect.any(String), commit: SHA });
  });

  it("returns commit null when VERCEL_GIT_COMMIT_SHA is unset", async () => {
    const body = await GET().json();

    expect(body).toHaveProperty("commit", null);
    expect(body.status).toBe("ok");
  });

  it("returns commit null when VERCEL_GIT_COMMIT_SHA is empty", async () => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = "";

    const body = await GET().json();

    expect(body).toHaveProperty("commit", null);
  });
});
