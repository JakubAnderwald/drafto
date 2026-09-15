import React from "react";
import { describeAccountDeletionFailure, type AccountDeletionResult } from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import {
  DeleteAccountPanel,
  DELETE_ACCOUNT_OFFLINE_NOTE,
  DELETE_ACCOUNT_PROMPT,
  DELETE_ACCOUNT_WARNING,
} from "@/components/sidebar/delete-account-panel";

type TestInstance = ReturnType<ReturnType<typeof render>["getByTestId"]>;

function isDisabled(node: TestInstance): boolean {
  return node.props.accessibilityState?.disabled === true;
}

function renderPanel({
  onConfirm,
  isOffline,
}: { onConfirm?: jest.Mock; isOffline?: boolean } = {}) {
  const onCancel = jest.fn();
  const confirm = onConfirm ?? jest.fn().mockResolvedValue({ status: "ok" });
  const utils = render(
    <DeleteAccountPanel onCancel={onCancel} onConfirm={confirm} isOffline={isOffline} />,
  );
  return { ...utils, onCancel, onConfirm: confirm };
}

describe("DeleteAccountPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("warns about what is deleted and prompts for DELETE", () => {
    const { getByText, getByLabelText } = renderPanel();

    expect(getByText(DELETE_ACCOUNT_WARNING)).toBeTruthy();
    expect(getByText(DELETE_ACCOUNT_PROMPT)).toBeTruthy();
    expect(getByLabelText(DELETE_ACCOUNT_PROMPT)).toBeTruthy();
  });

  it.each(["", "delete", "Delete", "DELET", "DELETE NOW"])(
    "keeps confirm disabled for %j",
    (typed) => {
      const { getByTestId, onConfirm } = renderPanel();

      fireEvent.changeText(getByTestId("delete-account-input"), typed);
      expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(true);

      fireEvent.press(getByTestId("delete-account-confirm"));
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("enables confirm once DELETE is typed, ignoring surrounding whitespace", () => {
    const { getByTestId } = renderPanel();

    fireEvent.changeText(getByTestId("delete-account-input"), "  DELETE ");

    expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(false);
  });

  it("calls onCancel from the Cancel button", () => {
    const { getByTestId, onCancel } = renderPanel();

    fireEvent.press(getByTestId("delete-account-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape", () => {
    const { getByTestId, onCancel } = renderPanel();

    fireEvent(getByTestId("delete-account-input"), "keyDown", { nativeEvent: { key: "Escape" } });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm and stays pending with no error when the deletion succeeds", async () => {
    const { getByTestId, queryByRole, onConfirm } = renderPanel();

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    await act(async () => {
      fireEvent.press(getByTestId("delete-account-confirm"));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(queryByRole("alert")).toBeNull();
    // The auth change unmounts the panel; until then it must not offer a second send.
    expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(true);
  });

  const failures: Array<Exclude<AccountDeletionResult, { status: "ok" }>> = [
    { status: "network" },
    { status: "last-admin" },
    { status: "unauthorized" },
    { status: "failed", httpStatus: 500 },
  ];

  it.each(failures)("shows the shared failure copy and stays open for $status", async (result) => {
    const onConfirm = jest.fn().mockResolvedValue(result);
    const { getByTestId, findByText, onCancel } = renderPanel({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    expect(await findByText(describeAccountDeletionFailure(result))).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
    // The user can retry without retyping.
    expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(false);
  });

  it("shows the generic failure copy when onConfirm throws", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const onConfirm = jest.fn().mockRejectedValue(new Error("boom"));
    const { getByTestId, findByText } = renderPanel({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    expect(
      await findByText(describeAccountDeletionFailure({ status: "failed", httpStatus: 0 })),
    ).toBeTruthy();
    errorSpy.mockRestore();
  });

  it("disables confirm and shows the offline note while offline", () => {
    const { getByTestId, getByText, onConfirm } = renderPanel({ isOffline: true });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");

    expect(getByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeTruthy();
    expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(true);
    fireEvent.press(getByTestId("delete-account-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not show the offline note while online", () => {
    const { queryByText } = renderPanel();

    expect(queryByText(DELETE_ACCOUNT_OFFLINE_NOTE)).toBeNull();
  });

  it("disables both buttons and blocks a second request while pending", async () => {
    let resolveDeletion: (result: AccountDeletionResult) => void = () => {};
    const onConfirm = jest.fn(
      () =>
        new Promise<AccountDeletionResult>((resolve) => {
          resolveDeletion = resolve;
        }),
    );
    const { getByTestId, onCancel } = renderPanel({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    await waitFor(() => expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(true));
    expect(isDisabled(getByTestId("delete-account-cancel"))).toBe(true);

    fireEvent.press(getByTestId("delete-account-confirm"));
    fireEvent.press(getByTestId("delete-account-cancel"));
    fireEvent(getByTestId("delete-account-input"), "keyDown", { nativeEvent: { key: "Escape" } });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      resolveDeletion({ status: "network" });
    });

    expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(false);
    expect(isDisabled(getByTestId("delete-account-cancel"))).toBe(false);
  });

  it("does nothing with a failure that resolves after the panel has unmounted", async () => {
    let resolveDeletion: (result: AccountDeletionResult) => void = () => {};
    const onConfirm = jest.fn(
      () =>
        new Promise<AccountDeletionResult>((resolve) => {
          resolveDeletion = resolve;
        }),
    );
    // The panel only reads `status` once it knows it is still mounted, so a read
    // here means the unmount guard was skipped.
    const statusRead = jest.fn();
    const failure = {
      get status() {
        statusRead();
        return "network" as const;
      },
    } as AccountDeletionResult;
    const { getByTestId, unmount } = renderPanel({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));
    unmount();

    await act(async () => {
      resolveDeletion(failure);
    });

    expect(statusRead).not.toHaveBeenCalled();
  });
});
