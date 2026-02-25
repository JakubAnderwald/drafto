"use client";

import { useState } from "react";

interface PendingUser {
  id: string;
  display_name: string | null;
  created_at: string;
}

export function AdminUserList({ initialUsers }: { initialUsers: PendingUser[] }) {
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>(initialUsers);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  async function handleApprove(userId: string) {
    setApprovingId(userId);

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
      setApprovingId(null);
    }
  }

  if (pendingUsers.length === 0) {
    return <p className="text-gray-500">No pending users to approve.</p>;
  }

  return (
    <ul className="space-y-3">
      {pendingUsers.map((user) => (
        <li key={user.id} className="flex items-center justify-between rounded-lg border p-4">
          <div>
            <p className="font-medium">{user.display_name ?? user.id}</p>
            <p className="text-sm text-gray-500">
              Signed up {new Date(user.created_at).toLocaleDateString()}
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleApprove(user.id)}
            disabled={approvingId === user.id}
            className="rounded-md bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          >
            {approvingId === user.id ? "Approving..." : "Approve"}
          </button>
        </li>
      ))}
    </ul>
  );
}
