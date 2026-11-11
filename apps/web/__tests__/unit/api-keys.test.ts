import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-key",
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}));

const { GET, POST } = await import("@/app/api/api-keys/route");

const approvedProfile = {
  select: () => ({
    eq: () => ({
      single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
    }),
  }),
};

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

describe("GET /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const response = await GET(new NextRequest("http://localhost:3000/api/api-keys"));
    expect(response.status).toBe(401);
  });

  it("returns API keys for authenticated user", async () => {
    authenticateAs("user-1");

    const keys = [
      {
        id: "key-1",
        key_prefix: "dk_abcde",
        name: "Claude Desktop",
        created_at: "2026-04-11T00:00:00Z",
        last_used_at: null,
        revoked_at: null,
      },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: keys, error: null }),
          }),
        }),
      };
    });

    const response = await GET(new NextRequest("http://localhost:3000/api/api-keys"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Claude Desktop");
  });
});

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const req = new NextRequest("http://localhost/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "Test Key" }),
    });

    const response = await POST(req);
    expect(response.status).toBe(401);
  });

  it("creates a new API key and returns the raw key", async () => {
    authenticateAs("user-1");

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        insert: () => ({
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: "key-new", key_prefix: "dk_test1", name: "Test Key" },
                error: null,
              }),
          }),
        }),
      };
    });

    const req = new NextRequest("http://localhost/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "Test Key" }),
    });

    const response = await POST(req);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.key).toMatch(/^dk_/);
    expect(body.key).toHaveLength(51); // dk_ + 48 hex chars
    expect(body.id).toBe("key-new");
  });
});

describe("POST /api/api-keys body validation", () => {
  /**
   * Mocks an approved user's `api_keys` insert and returns the insert spy, so a
   * test can assert the stored `name` — or that nothing was inserted on a 400.
   */
  function mockApiKeysInsert() {
    const insert = vi.fn((row: { name: string }) => ({
      select: () => ({
        single: () =>
          Promise.resolve({
            data: { id: "key-new", key_prefix: "dk_test1", name: row.name },
            error: null,
          }),
      }),
    }));
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return { insert };
    });
    return insert;
  }

  function postWithRawBody(body?: string) {
    return POST(new NextRequest("http://localhost/api/api-keys", { method: "POST", body }));
  }

  function postWithJson(body: unknown) {
    return postWithRawBody(JSON.stringify(body));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAs("user-1");
  });

  it("returns 400 for a non-JSON body without inserting", async () => {
    const insert = mockApiKeysInsert();

    const response = await postWithRawBody("not json");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty body without inserting", async () => {
    const insert = mockApiKeysInsert();

    const response = await postWithRawBody();

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 5],
    ["a string", "str"],
  ])("returns 400 when the JSON body is %s without inserting", async (_label, body) => {
    const insert = mockApiKeysInsert();

    const response = await postWithJson(body);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    ["a number", 123],
    ["null", null],
    ["a boolean", true],
    ["an object", { first: "x" }],
  ])("returns 400 when name is %s without inserting", async (_label, name) => {
    const insert = mockApiKeysInsert();

    const response = await postWithJson({ name });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("name must be a string");
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 400 when the trimmed name is over 100 characters without inserting", async () => {
    const insert = mockApiKeysInsert();

    const response = await postWithJson({ name: "a".repeat(101) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("name must be at most 100 characters");
    expect(insert).not.toHaveBeenCalled();
  });

  it("accepts a name of exactly 100 characters", async () => {
    const insert = mockApiKeysInsert();
    const name = "a".repeat(100);

    const response = await postWithJson({ name });

    expect(response.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user-1", name }));
    expect((await response.json()).name).toBe(name);
  });

  it("applies the cap after trimming and stores the trimmed name", async () => {
    const insert = mockApiKeysInsert();
    const name = "b".repeat(100);

    const response = await postWithJson({ name: `   ${name}   ` });

    expect(response.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name }));
  });

  it.each([
    ["no name", {}],
    ["an empty name", { name: "" }],
    ["a whitespace-only name", { name: "   " }],
  ])('defaults to "Untitled key" for %s', async (_label, body) => {
    const insert = mockApiKeysInsert();

    const response = await postWithJson(body);

    expect(response.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name: "Untitled key" }));
    const json = await response.json();
    expect(json).toMatchObject({ id: "key-new", key_prefix: "dk_test1", name: "Untitled key" });
    expect(json.key).toMatch(/^dk_[0-9a-f]{48}$/);
  });
});
