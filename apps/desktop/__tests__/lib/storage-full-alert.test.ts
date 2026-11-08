import { Alert } from "react-native";

import {
  STORAGE_FULL_ALERT_DEDUPE_MS,
  STORAGE_FULL_ALERT_TITLE,
  resetStorageFullAlert,
  showStorageFullAlert,
} from "@/lib/storage-full-alert";

describe("showStorageFullAlert", () => {
  beforeEach(() => {
    resetStorageFullAlert();
    jest.spyOn(Alert, "alert").mockImplementation(() => {});
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows the alert with the given message", () => {
    showStorageFullAlert("Storage full: test");
    expect(Alert.alert).toHaveBeenCalledWith(STORAGE_FULL_ALERT_TITLE, "Storage full: test");
  });

  it("drops a second alert for the same refusal, then shows the next one", () => {
    showStorageFullAlert("first");
    showStorageFullAlert("second");
    expect(Alert.alert).toHaveBeenCalledTimes(1);

    (Date.now as jest.Mock).mockReturnValue(1_000_000 + STORAGE_FULL_ALERT_DEDUPE_MS);
    showStorageFullAlert("third");
    expect(Alert.alert).toHaveBeenCalledTimes(2);
    expect(Alert.alert).toHaveBeenLastCalledWith(STORAGE_FULL_ALERT_TITLE, "third");
  });
});
