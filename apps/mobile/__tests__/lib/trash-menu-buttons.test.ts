import { Platform, type AlertButton } from "react-native";

import { trashMenuButtons } from "@/lib/trash-menu-buttons";

const restore: AlertButton = { text: "Restore" };
const deleteForever: AlertButton = { text: "Delete permanently", style: "destructive" };
const cancel: AlertButton = { text: "Cancel", style: "cancel" };

describe("trashMenuButtons", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("leads with Restore on iOS, which moves the cancel button last itself", () => {
    jest.replaceProperty(Platform, "OS", "ios");

    expect(trashMenuButtons(restore, deleteForever, cancel)).toEqual([
      restore,
      deleteForever,
      cancel,
    ]);
  });

  it("orders Android's neutral, negative and positive slots: Cancel, Delete, Restore", () => {
    jest.replaceProperty(Platform, "OS", "android");

    expect(trashMenuButtons(restore, deleteForever, cancel)).toEqual([
      cancel,
      deleteForever,
      restore,
    ]);
  });
});
