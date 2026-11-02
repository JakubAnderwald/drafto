import React from "react";
import { describeAccountDeletionFailure, type AccountDeletionResult } from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import {
  DeleteAccountPanel,
  DELETE_ACCOUNT_APPLE_NOTICE,
  DELETE_ACCOUNT_APPLE_WAITING,
  DELETE_ACCOUNT_OFFLINE_NOTE,
  DELETE_ACCOUNT_PROMPT,
  DELETE_ACCOUNT_WARNING,
} from "@/components/sidebar/delete-account-panel";

const mockAppleState = { required: false, userId: "user-123" as string | null };
jest.mock("@/hooks/use-apple-deletion-confirmation", () => ({
  useAppleDeletionConfirmation: () => mockAppleState,
}));

type Grant = { authorizationCode: string; clientId: string } | null;
const mockStartAppleConfirmation = jest.fn();
jest.mock("@/lib/apple-revocation", () => ({
  startAppleConfirmation: () => mockStartAppleConfirmation(),
}));

/** A confirmation the test settles by hand, as the relay link or a skip would. */
function controlledConfirmation() {
  let resolve: (grant: Grant) => void = () => undefined;
  const grant = new Promise<Grant>((r) => {
    resolve = r;
  });
  const skip = jest.fn(() => resolve(null));
  return { confirmation: { grant, skip }, resolve, skip };
}

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
    mockAppleState.required = false;
  });

  it("shows no Apple notice and calls onConfirm without a grant for a non-Apple user", async () => {
    const { getByTestId, queryByText, onConfirm } = renderPanel();

    expect(queryByText(DELETE_ACCOUNT_APPLE_NOTICE)).toBeNull();
    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    await act(async () => {
      fireEvent.press(getByTestId("delete-account-confirm"));
    });

    expect(mockStartAppleConfirmation).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledWith();
  });

  describe("for an Apple-linked user", () => {
    beforeEach(() => {
      mockAppleState.required = true;
    });

    async function startDeletion() {
      const controlled = controlledConfirmation();
      mockStartAppleConfirmation.mockReturnValue(controlled.confirmation);
      const utils = renderPanel();
      fireEvent.changeText(utils.getByTestId("delete-account-input"), "DELETE");
      await act(async () => {
        fireEvent.press(utils.getByTestId("delete-account-confirm"));
      });
      return { ...utils, ...controlled };
    }

    it("explains the browser step before the user starts", () => {
      const { getByText } = renderPanel();

      expect(getByText(DELETE_ACCOUNT_APPLE_NOTICE)).toBeTruthy();
      expect(mockStartAppleConfirmation).not.toHaveBeenCalled();
    });

    it("waits for Apple, then deletes with the grant for the user who started", async () => {
      const { getByText, onConfirm, resolve } = await startDeletion();

      expect(getByText(DELETE_ACCOUNT_APPLE_WAITING)).toBeTruthy();
      expect(onConfirm).not.toHaveBeenCalled();

      const grant = { authorizationCode: "apple-code", clientId: "eu.drafto.web.auth" };
      await act(async () => {
        resolve(grant);
      });

      expect(onConfirm).toHaveBeenCalledWith(grant, "user-123");
    });

    it("deletes without a grant on Continue without Apple", async () => {
      const { getByTestId, onConfirm, skip } = await startDeletion();

      await act(async () => {
        fireEvent.press(getByTestId("delete-account-apple-skip"));
      });

      expect(skip).toHaveBeenCalled();
      expect(onConfirm).toHaveBeenCalledWith(undefined, "user-123");
    });

    it("deletes nothing on Cancel, even if Apple answers afterwards", async () => {
      const { getByTestId, queryByText, onConfirm, onCancel, skip, resolve } =
        await startDeletion();

      await act(async () => {
        fireEvent.press(getByTestId("delete-account-apple-cancel"));
      });
      await act(async () => {
        resolve({ authorizationCode: "late", clientId: "eu.drafto.web.auth" });
      });

      expect(skip).toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(queryByText(DELETE_ACCOUNT_APPLE_WAITING)).toBeNull();
      expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(false);
    });

    it("deletes nothing when Apple answers during a sign-out, and can be retried after it", async () => {
      const { getByTestId, queryByTestId, onConfirm, onCancel, skip, resolve, rerender } =
        await startDeletion();

      // The sidebar disables the panel while a sign-out runs.
      rerender(<DeleteAccountPanel onCancel={onCancel} onConfirm={onConfirm} disabled />);
      const skipButton = getByTestId("delete-account-apple-skip");
      expect(isDisabled(skipButton)).toBe(true);
      fireEvent.press(skipButton);
      expect(skip).not.toHaveBeenCalled();

      await act(async () => {
        resolve({ authorizationCode: "apple-code", clientId: "eu.drafto.web.auth" });
      });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(queryByTestId("delete-account-apple-waiting")).toBeNull();
      expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(true);

      // The sign-out ended without signing out (e.g. "Sign out?" was cancelled).
      rerender(<DeleteAccountPanel onCancel={onCancel} onConfirm={onConfirm} />);
      expect(isDisabled(getByTestId("delete-account-confirm"))).toBe(false);
      const retry = controlledConfirmation();
      mockStartAppleConfirmation.mockReturnValue(retry.confirmation);
      await act(async () => {
        fireEvent.press(getByTestId("delete-account-confirm"));
      });
      await act(async () => {
        retry.resolve(null);
      });

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledWith(undefined, "user-123");
    });

    it("keeps waiting for Apple through a sign-out that ends without signing out", async () => {
      const { getByTestId, onConfirm, onCancel, resolve, rerender } = await startDeletion();

      rerender(<DeleteAccountPanel onCancel={onCancel} onConfirm={onConfirm} disabled />);
      rerender(<DeleteAccountPanel onCancel={onCancel} onConfirm={onConfirm} />);

      expect(getByTestId("delete-account-apple-waiting")).toBeTruthy();
      expect(isDisabled(getByTestId("delete-account-apple-skip"))).toBe(false);
      const grant = { authorizationCode: "apple-code", clientId: "eu.drafto.web.auth" };
      await act(async () => {
        resolve(grant);
      });

      expect(onConfirm).toHaveBeenCalledWith(grant, "user-123");
    });

    it("releases the pending confirmation when the panel unmounts", async () => {
      const { unmount, onConfirm, skip } = await startDeletion();

      unmount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(skip).toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
    });
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
