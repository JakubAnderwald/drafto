"use client";

import { useState } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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
    return (
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
    );
  }

  return (
    <ul className="space-y-3">
      {pendingUsers.map((user) => (
        <li key={user.id}>
          <Card shadow="sm">
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-fg font-medium">{user.display_name ?? user.id}</p>
                <p className="text-fg-muted text-sm">
                  Signed up {new Date(user.created_at).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="primary"
                size="sm"
                loading={approvingId === user.id}
                onClick={() => handleApprove(user.id)}
                className="bg-success hover:bg-success-hover focus-visible:ring-success"
              >
                {approvingId === user.id ? "Approving..." : "Approve"}
              </Button>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
