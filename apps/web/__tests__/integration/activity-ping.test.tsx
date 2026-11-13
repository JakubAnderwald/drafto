import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: mockRpc }),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}));

const { ActivityPing } = await import("@/components/layout/activity-ping");
const { ACTIVITY_DAY_STORAGE_KEY } = await import("@/hooks/use-activity-ping");

describe("<ActivityPing />", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ error: null });
  });

  it("renders nothing and records today's web activity day once", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const { container } = render(
      <StrictMode>
        <ActivityPing userId="user-1" />
      </StrictMode>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("record_activity", {
      p_days: [today],
      p_client: "web",
    });
    await waitFor(() =>
      expect(window.sessionStorage.getItem(ACTIVITY_DAY_STORAGE_KEY)).toBe(`user-1:${today}`),
    );
  });
});
