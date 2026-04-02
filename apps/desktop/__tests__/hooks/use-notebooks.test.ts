import { renderHook, waitFor } from "@testing-library/react-native";

function fakeObservable<T>(value: T) {
  return {
    subscribe(observer: { next: (v: T) => void; error?: (e: unknown) => void }) {
      observer.next(value);
      return { unsubscribe: jest.fn() };
    },
  };
}

function fakeErrorObservable(error: Error) {
  return {
    subscribe(observer: { next?: (v: unknown) => void; error: (e: unknown) => void }) {
      observer.error(error);
      return { unsubscribe: jest.fn() };
    },
  };
}

const mockObserve = jest.fn();
const mockQuery = jest.fn(() => ({ observe: mockObserve }));

jest.mock("@/db", () => ({
  get database() {
    return {
      get: () => ({ query: mockQuery }),
    };
  },
  Notebook: {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useNotebooks } = require("@/hooks/use-notebooks") as typeof import("@/hooks/use-notebooks");

describe("useNotebooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockObserve.mockReturnValue(fakeObservable([]));
  });

  it("queries notebooks on mount", async () => {
    const notebooks = [{ id: "1", name: "Work" }];
    mockObserve.mockReturnValue(fakeObservable(notebooks));

    const { result } = renderHook(() => useNotebooks());

    await waitFor(() => {
      expect(result.current.notebooks).toEqual(notebooks);
      expect(result.current.loading).toBe(false);
    });

    expect(mockQuery).toHaveBeenCalled();
  });

  it("sets error on query failure", async () => {
    mockObserve.mockReturnValue(fakeErrorObservable(new Error("DB error")));

    const { result } = renderHook(() => useNotebooks());

    await waitFor(() => {
      expect(result.current.error).toBe("DB error");
      expect(result.current.loading).toBe(false);
    });
  });

  it("starts with loading true", () => {
    mockObserve.mockReturnValue({
      subscribe: () => ({ unsubscribe: jest.fn() }),
    });

    const { result } = renderHook(() => useNotebooks());

    expect(result.current.loading).toBe(true);
  });
});
