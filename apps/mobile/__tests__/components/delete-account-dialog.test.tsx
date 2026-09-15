import React from "react";
import { describeAccountDeletionFailure, type AccountDeletionResult } from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { DeleteAccountDialog } from "../../src/components/delete-account-dialog";

function renderDialog(overrides: Partial<React.ComponentProps<typeof DeleteAccountDialog>> = {}) {
  const onCancel = jest.fn();
  const onConfirm = jest.fn<Promise<AccountDeletionResult>, []>();
  const props = { visible: true, onCancel, onConfirm, ...overrides };
  const utils = render(<DeleteAccountDialog {...props} />);
  return { ...utils, props, onCancel: props.onCancel, onConfirm: props.onConfirm };
}

describe("DeleteAccountDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the warning and confirmation prompt", () => {
    const { getByText, getByTestId } = renderDialog();

    expect(getByText("Delete account?")).toBeTruthy();
    expect(
      getByText(
        "This permanently deletes your Drafto account and all of your notebooks, notes and attachments. This cannot be undone.",
      ),
    ).toBeTruthy();
    expect(getByText("Type DELETE to confirm")).toBeTruthy();
    expect(getByTestId("delete-account-input")).toBeTruthy();
  });

  it("renders nothing when not visible", () => {
    const { queryByText } = renderDialog({ visible: false });

    expect(queryByText("Delete account?")).toBeNull();
  });

  it("keeps confirm disabled until DELETE is typed exactly", () => {
    const { getByTestId, onConfirm } = renderDialog();
    const confirm = getByTestId("delete-account-confirm");

    expect(confirm).toBeDisabled();

    fireEvent.changeText(getByTestId("delete-account-input"), "delete");
    expect(getByTestId("delete-account-confirm")).toBeDisabled();
    fireEvent.press(getByTestId("delete-account-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.changeText(getByTestId("delete-account-input"), "DELET");
    expect(getByTestId("delete-account-confirm")).toBeDisabled();

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    expect(getByTestId("delete-account-confirm")).toBeEnabled();
  });

  it("accepts DELETE surrounded by whitespace", () => {
    const { getByTestId } = renderDialog();

    fireEvent.changeText(getByTestId("delete-account-input"), "  DELETE ");

    expect(getByTestId("delete-account-confirm")).toBeEnabled();
  });

  it("calls onCancel when Cancel is pressed", () => {
    const { getByTestId, onCancel, onConfirm } = renderDialog();

    fireEvent.press(getByTestId("delete-account-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onConfirm exactly once, even on a double tap", async () => {
    const onConfirm = jest
      .fn<Promise<AccountDeletionResult>, []>()
      .mockResolvedValue({ status: "ok" });
    const { getByTestId } = renderDialog({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    const confirm = getByTestId("delete-account-confirm");
    fireEvent.press(confirm);
    fireEvent.press(confirm);

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it("disables confirm, cancel and the input while the request is pending", async () => {
    let resolveRequest: (result: AccountDeletionResult) => void = () => {};
    const onConfirm = jest.fn<Promise<AccountDeletionResult>, []>(
      () =>
        new Promise<AccountDeletionResult>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const onCancel = jest.fn();
    const { getByTestId } = renderDialog({ onConfirm, onCancel });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(getByTestId("delete-account-confirm")).toBeDisabled();
    });
    expect(getByTestId("delete-account-cancel")).toBeDisabled();
    expect(getByTestId("delete-account-input").props.editable).toBe(false);

    fireEvent.press(getByTestId("delete-account-cancel"));
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      resolveRequest({ status: "network" });
    });

    await waitFor(() => {
      expect(getByTestId("delete-account-confirm")).toBeEnabled();
    });
    expect(getByTestId("delete-account-cancel")).toBeEnabled();
  });

  it.each<Exclude<AccountDeletionResult, { status: "ok" }>>([
    { status: "network" },
    { status: "last-admin" },
    { status: "unauthorized" },
    { status: "failed", httpStatus: 500 },
  ])("shows the failure copy and stays open for a $status result", async (failure) => {
    const onConfirm = jest.fn<Promise<AccountDeletionResult>, []>().mockResolvedValue(failure);
    const { getByTestId, findByText, getByText } = renderDialog({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    expect(await findByText(describeAccountDeletionFailure(failure))).toBeTruthy();
    expect(getByText("Delete account?")).toBeTruthy();
    expect(getByTestId("delete-account-confirm")).toBeEnabled();
  });

  it("shows a generic failure if the request throws unexpectedly", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const onConfirm = jest
      .fn<Promise<AccountDeletionResult>, []>()
      .mockRejectedValue(new Error("boom"));
    const { getByTestId, findByText } = renderDialog({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    expect(
      await findByText(describeAccountDeletionFailure({ status: "failed", httpStatus: 0 })),
    ).toBeTruthy();
    errorSpy.mockRestore();
  });

  it("does not show an error after a successful deletion", async () => {
    const onConfirm = jest
      .fn<Promise<AccountDeletionResult>, []>()
      .mockResolvedValue({ status: "ok" });
    const { getByTestId, queryByTestId } = renderDialog({ onConfirm });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
    expect(queryByTestId("delete-account-error")).toBeNull();
  });

  it("clears the typed text and error when closed and reopened", async () => {
    const onConfirm = jest
      .fn<Promise<AccountDeletionResult>, []>()
      .mockResolvedValue({ status: "network" });
    const onCancel = jest.fn();
    const { getByTestId, findByTestId, queryByTestId, rerender } = renderDialog({
      onConfirm,
      onCancel,
    });

    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));
    expect(await findByTestId("delete-account-error")).toBeTruthy();

    rerender(<DeleteAccountDialog visible={false} onCancel={onCancel} onConfirm={onConfirm} />);
    rerender(<DeleteAccountDialog visible onCancel={onCancel} onConfirm={onConfirm} />);

    expect(getByTestId("delete-account-input").props.value).toBe("");
    expect(queryByTestId("delete-account-error")).toBeNull();
    expect(getByTestId("delete-account-confirm")).toBeDisabled();
  });
});
