import React from "react";
import { FlatList } from "react-native";
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

  it("opens the note for a result", () => {
    const { getByText } = render(<SearchScreen />);

    fireEvent.press(getByText("Packing"));

    expect(push).toHaveBeenCalledWith("/notes/note-1");
  });

  it("opens a result on the first tap while the keyboard is still up", () => {
    const { UNSAFE_getByType } = render(<SearchScreen />);

    // With the default ("never") the first tap only dismissed the keyboard.
    expect(UNSAFE_getByType(FlatList).props.keyboardShouldPersistTaps).toBe("handled");
  });
});
