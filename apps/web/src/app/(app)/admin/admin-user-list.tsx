"use client";

import { useState } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRelativeTime } from "@drafto/shared";

export interface PendingUser {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

const DELETE_FAILED_MESSAGE = "Failed to delete user. Please try again.";

async function readErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return DELETE_FAILED_MESSAGE;
}

export function AdminUserList({ initialUsers }: { initialUsers: PendingUser[] }) {
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>(initialUsers);
  // A set, not a single id: overlapping approves must not clear each other's
  // in-flight state, or a row mid-approve would get its Delete button back.
  const [approvingIds, setApprovingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleApprove(userId: string) {
    setApprovingIds((prev) => new Set(prev).add(userId));
    // Approving settles the question — don't leave a delete confirmation armed for this row.
    setConfirmingDeleteId((prev) => (prev === userId ? null : prev));

    try {
      const response = await fetch("/api/admin/approve-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      if (response.ok) {
        setPendingUsers((prev) => prev.filter((u) => u.id !== userId));
      }
    } finally {
      setApprovingIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  }

  function requestDelete(userId: string) {
    setDeleteError(null);
    setConfirmingDeleteId(userId);
  }

  function cancelDelete() {
    // The request is already on its way; closing the dialog would hide its outcome.
    if (deletingId) return;
    setConfirmingDeleteId(null);
    setDeleteError(null);
  }

  async function confirmDelete(userId: string) {
    setDeletingId(userId);
    setDeleteError(null);

    try {
      const response = await fetch("/api/admin/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      if (response.ok) {
        setPendingUsers((prev) => prev.filter((u) => u.id !== userId));
        setConfirmingDeleteId(null);
      } else {
        setDeleteError(await readErrorMessage(response));
      }
    } catch {
      setDeleteError(DELETE_FAILED_MESSAGE);
    } finally {
      setDeletingId(null);
    }
  }

  const pendingCount = (
    <p className="text-fg-muted mb-3 text-sm" aria-live="polite">
      {pendingUsers.length} pending
    </p>
  );

  if (pendingUsers.length === 0) {
    return (
      <div>
        {pendingCount}
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <svg
            className="text-fg-subtle mb-3 h-12 w-12"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"
            />
          </svg>
          <p className="text-fg-muted text-sm">No pending users to approve.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {pendingCount}
      <ul className="space-y-3">
        {pendingUsers.map((user) => {
          const isApproving = approvingIds.has(user.id);
          const isDeleting = deletingId === user.id;

          return (
            <li key={user.id}>
              <Card shadow="sm">
                <CardBody>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-fg truncate font-medium">{user.email}</p>
                      <p className="text-fg-muted truncate text-sm">
                        {user.display_name ? `${user.display_name} · ` : ""}
                        Signed up {formatRelativeTime(user.created_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="success"
                        size="sm"
                        loading={isApproving}
                        disabled={isDeleting}
                        onClick={() => handleApprove(user.id)}
                      >
                        {isApproving ? "Approving..." : "Approve"}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={isDeleting}
                        // One delete at a time: a second dialog would take over the in-flight one.
                        disabled={isApproving || deletingId !== null}
                        onClick={() => requestDelete(user.id)}
                      >
                        {isDeleting ? "Deleting..." : "Delete"}
                      </Button>
                    </div>
                  </div>
                  {confirmingDeleteId === user.id && (
                    <ConfirmDialog
                      className="mt-3"
                      title="Delete user?"
                      confirmLabel="Delete"
                      cancelLabel="Cancel"
                      variant="danger"
                      error={deleteError}
                      loading={isDeleting}
                      onConfirm={() => confirmDelete(user.id)}
                      onCancel={cancelDelete}
                    >
                      This permanently deletes {user.email} and all of their data. This cannot be
                      undone.
                    </ConfirmDialog>
                  )}
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
