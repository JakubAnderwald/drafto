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

const { GET, POST } = await import("@/app/api/notebooks/route");

/** Minimal GET request for route handlers that require a NextRequest parameter */
const mockGetRequest = () => new NextRequest("http://localhost:3000/api/notebooks");

const approvedProfile = {
  select: () => ({
    eq: () => ({
      single: () => Promise.resolve({ data: { is_approved: true }, error: null }),
    }),
  }),
};

/** The duplicate check's read of the user's notebook names (PrimeTestLab 11035 M-01). */
function namesQuery(
  names: Array<{ id: string; name: string }>,
  error: { message: string } | null = null,
) {
  return {
    select: vi.fn((columns: string) => ({
      eq: vi.fn((column: string, value: string) => {
        expect(columns).toBe("id, name");
        expect([column, value]).toEqual(["user_id", "user-1"]);
        return {
          order: () => ({
            range: () => Promise.resolve({ data: error ? null : names, error }),
          }),
        };
      }),
    })),
  };
}

function authenticateAs(userId: string) {
  mockGetUser.mockResolvedValue({
    data: { user: { id: userId, email: "test@test.com" } },
    error: null,
  });
}

describe("GET /api/notebooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const response = await GET(mockGetRequest());
    expect(response.status).toBe(401);
  });

  it("returns notebooks for authenticated user", async () => {
    authenticateAs("user-1");

    const notebooks = [
      {
        id: "nb-1",
        name: "Notes",
        user_id: "user-1",
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
        notes: [{ count: 3 }],
      },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: notebooks, error: null }),
            }),
          }),
        }),
      };
    });

    const response = await GET(mockGetRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Notes");
  });

  it("PrimeTestLab 11035 S-03: counts each notebook's notes, leaving trashed ones out", async () => {
    authenticateAs("user-1");

    const select = vi.fn();
    const filters: Array<[string, unknown]> = [];
    const rows = [
      { id: "nb-1", name: "Notes", notes: [{ count: 3 }] },
      { id: "nb-2", name: "Empty", notes: [{ count: 0 }] },
      { id: "nb-3", name: "No embed", notes: null },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      const builder = {
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        order: () => Promise.resolve({ data: rows, error: null }),
      };
      select.mockReturnValue(builder);
      return { select };
    });

    const response = await GET(mockGetRequest());
    const body = await response.json();

    expect(select).toHaveBeenCalledWith("*, notes(count)");
    expect(filters).toEqual([
      ["user_id", "user-1"],
      ["notes.is_trashed", false],
    ]);
    expect(body).toEqual([
      { id: "nb-1", name: "Notes", note_count: 3 },
      { id: "nb-2", name: "Empty", note_count: 0 },
      { id: "nb-3", name: "No embed", note_count: 0 },
    ]);
  });
});

describe("POST /api/notebooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Not auth" } });

    const request = new NextRequest("http://localhost:3000/api/notebooks", {
      method: "POST",
      body: JSON.stringify({ name: "Test" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    authenticateAs("user-1");
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {};
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("creates a notebook", async () => {
    authenticateAs("user-1");

    const notebook = { id: "nb-2", name: "Work", user_id: "user-1" };
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") return approvedProfile;
      return {
        ...namesQuery([{ id: "nb-1", name: "Personal" }]),
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: notebook, error: null }),
          }),
        }),
      };
    });

    const request = new NextRequest("http://localhost:3000/api/notebooks", {
      method: "POST",
      body: JSON.stringify({ name: "Work" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe("Work");
  });

  describe("PrimeTestLab 11035 M-01: duplicate names", () => {
    function postName(name: string) {
      return POST(
        new NextRequest("http://localhost:3000/api/notebooks", {
          method: "POST",
          body: JSON.stringify({ name }),
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    it("refuses a name the user already has, ignoring case and spacing, with a 409", async () => {
      authenticateAs("user-1");
      const insert = vi.fn();
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return { ...namesQuery([{ id: "nb-1", name: "Project Ideas" }]), insert };
      });

      const response = await postName("  project   IDEAS ");

      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe(
        'A notebook named "Project Ideas" already exists. Choose a different name.',
      );
      expect(insert).not.toHaveBeenCalled();
    });

    it("answers 500 without inserting when the names can't be read", async () => {
      authenticateAs("user-1");
      const insert = vi.fn();
      mockFrom.mockImplementation((table: string) => {
        if (table === "profiles") return approvedProfile;
        return { ...namesQuery([], { message: "db down" }), insert };
      });

      const response = await postName("Work");

      expect(response.status).toBe(500);
      expect(insert).not.toHaveBeenCalled();
    });
  });
});
