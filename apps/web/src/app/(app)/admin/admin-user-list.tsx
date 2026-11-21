"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import {
  AdminAccountRow,
  type AccountBusy,
  type AccountConfirm,
  type AdminAccount,
} from "@/app/(app)/admin/admin-account-row";

export type { AdminAccount } from "@/app/(app)/admin/admin-account-row";

const FAILED_MESSAGES: Record<AccountConfirm, string> = {
  suspend: "Failed to suspend user. Please try again.",
  delete: "Failed to delete user. Please try again.",
};

const ACTIVATE_FAILED_MESSAGE = "Failed to activate user. Please try again.";

const CONFIRM_ENDPOINTS: Record<AccountConfirm, string> = {
  suspend: "/api/admin/suspend-user",
  delete: "/api/admin/delete-user",
};

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return fallback;
}

function postUserId(url: string, userId: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

/**
 * Every account, in two sections (ADR 0094). Inactive accounts (`is_approved = false`: a
 * signup never activated, or one an admin suspended) can be activated or deleted; active
 * ones can be suspended. Admin accounts can't be suspended. A row moves between the
 * sections as soon as its request succeeds.
 */
export function AdminUserList({ initialUsers }: { initialUsers: AdminAccount[] }) {
  const [accounts, setAccounts] = useState<AdminAccount[]>(initialUsers);
  // A map, not a single id: overlapping activates must not clear each other's in-flight
  // state, or a row mid-activate would get its Delete button back.
  const [busy, setBusy] = useState<ReadonlyMap<string, AccountBusy>>(() => new Map());
  const [confirming, setConfirming] = useState<{ id: string; action: AccountConfirm } | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [activateErrors, setActivateErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  function setActivateError(userId: string, message: string | null) {
    setActivateErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(userId, message);
      else next.delete(userId);
      return next;
    });
  }

  function setRowBusy(userId: string, state: AccountBusy | null) {
    setBusy((prev) => {
      const next = new Map(prev);
      if (state) next.set(userId, state);
      else next.delete(userId);
      return next;
    });
  }

  function setActive(userId: string, isActive: boolean) {
    setAccounts((prev) => prev.map((a) => (a.id === userId ? { ...a, is_active: isActive } : a)));
  }

  // A suspend or delete is in flight: no other one can be confirmed meanwhile, and the open
  // dialog stays put so its outcome is shown.
  const confirmInFlight = [...busy.values()].some((b) => b === "suspending" || b === "deleting");

  async function handleActivate(userId: string) {
    setRowBusy(userId, "activating");
    // Activating settles the question: don't leave a delete confirmation armed for this row.
    setConfirming((prev) => (prev?.id === userId ? null : prev));

    setActivateError(userId, null);

    try {
      const response = await postUserId("/api/admin/approve-user", userId);
      if (response.ok) setActive(userId, true);
      else setActivateError(userId, await readErrorMessage(response, ACTIVATE_FAILED_MESSAGE));
    } catch (err) {
      Sentry.captureException(err, { extra: { where: "admin-user-list:activate", userId } });
      setActivateError(userId, ACTIVATE_FAILED_MESSAGE);
    } finally {
      setRowBusy(userId, null);
    }
  }

  function requestConfirm(userId: string, action: AccountConfirm) {
    setConfirmError(null);
    setConfirming({ id: userId, action });
  }

  function cancelConfirm() {
    // The request is already on its way; closing the dialog would hide its outcome.
    if (confirmInFlight) return;
    setConfirming(null);
    setConfirmError(null);
  }

  async function confirmAction(userId: string, action: AccountConfirm) {
    setRowBusy(userId, action === "suspend" ? "suspending" : "deleting");
    setConfirmError(null);

    try {
      const response = await postUserId(CONFIRM_ENDPOINTS[action], userId);
      if (response.ok) {
        if (action === "suspend") setActive(userId, false);
        else setAccounts((prev) => prev.filter((a) => a.id !== userId));
        setConfirming(null);
      } else {
        setConfirmError(await readErrorMessage(response, FAILED_MESSAGES[action]));
      }
    } catch (err) {
      Sentry.captureException(err, { extra: { where: `admin-user-list:${action}`, userId } });
      setConfirmError(FAILED_MESSAGES[action]);
    } finally {
      setRowBusy(userId, null);
    }
  }

  function renderRow(account: AdminAccount) {
    const rowConfirm = confirming?.id === account.id ? confirming.action : null;
    return (
      <AdminAccountRow
        key={account.id}
        account={account}
        busy={busy.get(account.id) ?? null}
        confirming={rowConfirm}
        confirmError={rowConfirm ? confirmError : null}
        activateError={account.is_active ? null : (activateErrors.get(account.id) ?? null)}
        confirmLocked={confirmInFlight}
        onActivate={() => handleActivate(account.id)}
        onRequestConfirm={(action) => requestConfirm(account.id, action)}
        onConfirm={() => rowConfirm && confirmAction(account.id, rowConfirm)}
        onCancelConfirm={cancelConfirm}
      />
    );
  }

  const inactive = accounts.filter((a) => !a.is_active);
  const active = accounts.filter((a) => a.is_active);

  return (
    <div className="space-y-8">
      <section aria-labelledby="admin-inactive-heading" data-testid="admin-inactive-accounts">
        <h2 id="admin-inactive-heading" className="text-fg mb-1 text-lg font-semibold">
          Inactive accounts
        </h2>
        <p className="text-fg-muted mb-3 text-sm" aria-live="polite">
          {inactive.length} inactive · signups never activated and suspended accounts. They
          can&rsquo;t reach their notes.
        </p>
        {inactive.length === 0 ? (
          <p className="text-fg-subtle py-6 text-center text-sm">No inactive accounts.</p>
        ) : (
          <ul className="space-y-3">{inactive.map(renderRow)}</ul>
        )}
      </section>

      <section aria-labelledby="admin-active-heading" data-testid="admin-active-accounts">
        <h2 id="admin-active-heading" className="text-fg mb-1 text-lg font-semibold">
          Active accounts
        </h2>
        <p className="text-fg-muted mb-3 text-sm" aria-live="polite">
          {active.length} active
        </p>
        {active.length === 0 ? (
          <p className="text-fg-subtle py-6 text-center text-sm">No active accounts.</p>
        ) : (
          <ul className="space-y-3">{active.map(renderRow)}</ul>
        )}
      </section>
    </div>
  );
}
