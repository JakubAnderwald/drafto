import React from "react";
import { FlatList, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { render, fireEvent } from "../helpers/test-utils";
import SearchScreen from "../../app/search";
import { useSearch } from "@/hooks/use-search";
import { spacing } from "@/theme/tokens";

jest.mock("@/hooks/use-search", () => ({ useSearch: jest.fn() }));

const mockedInsets = jest.mocked(useSafeAreaInsets);

describe("SearchScreen", () => {
  const push = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useRouter).mockReturnValue({ push } as unknown as ReturnType<typeof useRouter>);
    jest.mocked(useSearch).mockReturnValue({
      results: [{ id: "note-1", title: "Packing", isTrashed: false }],
      loading: false,
    } as unknown as ReturnType<typeof useSearch>);
    mockedInsets.mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0 });
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

  it("pads the last result clear of the home indicator or nav bar", () => {
    mockedInsets.mockReturnValue({ top: 47, bottom: 34, left: 0, right: 0 });

    const { UNSAFE_getByType } = render(<SearchScreen />);

    const content = StyleSheet.flatten(UNSAFE_getByType(FlatList).props.contentContainerStyle);
    expect(content.paddingBottom).toBe(spacing.sm + 34);
  });
});
