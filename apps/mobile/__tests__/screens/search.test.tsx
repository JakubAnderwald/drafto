import React from "react";
import { useRouter } from "expo-router";

import { render, fireEvent } from "../helpers/test-utils";
import SearchScreen from "../../app/search";
import { useSearch } from "@/hooks/use-search";

jest.mock("@/hooks/use-search", () => ({ useSearch: jest.fn() }));

describe("SearchScreen", () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
    jest.mocked(useSearch).mockReturnValue({
      results: [{ id: "note-1", title: "Packing", isTrashed: false }],
      loading: false,
    } as unknown as ReturnType<typeof useSearch>);
  });

  it("opens a result marked as opened from Search, so iOS gives its sheet a close button", () => {
    const { getByText } = render(<SearchScreen />);

    fireEvent.press(getByText("Packing"));

    expect(push).toHaveBeenCalledWith("/notes/note-1?from=search");
  });
});
