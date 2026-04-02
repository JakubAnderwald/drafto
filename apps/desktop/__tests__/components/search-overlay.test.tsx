import React from "react";

import { useSearch } from "@/hooks/use-search";

jest.mock("@/hooks/use-search", () => ({
  useSearch: jest.fn(),
}));

const mockUseSearch = useSearch as jest.Mock;

import { render, screen, fireEvent } from "../helpers/test-utils";
import { SearchOverlay } from "@/components/search/search-overlay";

const defaultProps = {
  visible: true,
  onClose: jest.fn(),
  onSelectNote: jest.fn(),
};

describe("SearchOverlay", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSearch.mockReturnValue({
      results: [],
      loading: false,
      error: null,
    });
  });

  it("renders nothing when visible=false", () => {
    const { toJSON } = render(<SearchOverlay {...defaultProps} visible={false} />);
    expect(toJSON()).toBeNull();
  });

  it("shows search input when visible=true", () => {
    render(<SearchOverlay {...defaultProps} />);
    expect(screen.getByPlaceholderText("Search notes...")).toBeTruthy();
  });

  it("calls onClose when backdrop is pressed", () => {
    const onClose = jest.fn();
    const { UNSAFE_root } = render(
      <SearchOverlay visible={true} onClose={onClose} onSelectNote={jest.fn()} />,
    );

    // Walk the component tree to find all nodes with an onPress prop
    function findAllWithOnPress(node: {
      props?: Record<string, unknown>;
      children?: unknown[];
    }): unknown[] {
      const found: unknown[] = [];
      if (node.props?.onPress) found.push(node);
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child && typeof child === "object") {
            found.push(...findAllWithOnPress(child as typeof node));
          }
        }
      }
      return found;
    }

    const pressableNodes = findAllWithOnPress(UNSAFE_root);
    // The first pressable with onPress should be the backdrop
    expect(pressableNodes.length).toBeGreaterThan(0);
    const backdrop = pressableNodes[0] as { props: { onPress: () => void } };
    backdrop.props.onPress();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows "No results found" for empty results with a query', () => {
    mockUseSearch.mockReturnValue({
      results: [],
      loading: false,
      error: null,
    });

    render(<SearchOverlay {...defaultProps} />);
    const input = screen.getByPlaceholderText("Search notes...");
    fireEvent.changeText(input, "some query");

    expect(screen.getByText("No results found")).toBeTruthy();
  });

  it("shows error text when search errors", () => {
    mockUseSearch.mockReturnValue({
      results: [],
      loading: false,
      error: "Search failed unexpectedly",
    });

    render(<SearchOverlay {...defaultProps} />);
    const input = screen.getByPlaceholderText("Search notes...");
    fireEvent.changeText(input, "broken query");

    expect(screen.getByText("Search failed unexpectedly")).toBeTruthy();
  });

  it("shows results and calls onSelectNote + onClose on select", () => {
    const onSelectNote = jest.fn();
    const onClose = jest.fn();

    const mockResults = [
      {
        id: "note-1",
        title: "First Note",
        updatedAt: new Date("2025-06-01"),
      },
      {
        id: "note-2",
        title: "Second Note",
        updatedAt: new Date("2025-06-02"),
      },
    ];

    mockUseSearch.mockReturnValue({
      results: mockResults,
      loading: false,
      error: null,
    });

    render(<SearchOverlay visible={true} onClose={onClose} onSelectNote={onSelectNote} />);

    const input = screen.getByPlaceholderText("Search notes...");
    fireEvent.changeText(input, "note");

    // Both results should be visible
    expect(screen.getByText("First Note")).toBeTruthy();
    expect(screen.getByText("Second Note")).toBeTruthy();

    // Press the first result
    fireEvent.press(screen.getByText("First Note"));

    expect(onSelectNote).toHaveBeenCalledWith("note-1");
    expect(onClose).toHaveBeenCalled();
  });
});
