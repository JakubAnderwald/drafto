"use client";

import { useState, type FormEvent } from "react";
import * as Sentry from "@sentry/nextjs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  bytesToMegabytes,
  formatMegabytes,
  storageUsageTone,
  type StorageUsageTone,
} from "@drafto/shared";

export interface UserStorage {
  id: string;
  email: string;
  usedBytes: number;
  /** null = unlimited. */
  quotaBytes: number | null;
}

const SAVE_FAILED_MESSAGE = "Failed to save the quota. Please try again.";
const INVALID_QUOTA_MESSAGE = "Enter a whole number of MB greater than 0, or tick Unlimited.";

const USAGE_TONE_CLASS: Record<StorageUsageTone, string> = {
  default: "text-fg",
  warning: "text-warning-text",
  danger: "text-error-text",
};

/** The number the quota input starts at: the quota in whole MB, or the default for unlimited. */
function initialMegabytes(quotaBytes: number | null): string {
  const bytes = quotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
  return String(Math.max(1, Math.round(bytesToMegabytes(bytes))));
}

function formatQuota(quotaBytes: number | null): string {
  return quotaBytes === null ? "Unlimited" : formatMegabytes(quotaBytes);
}

async function readErrorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return SAVE_FAILED_MESSAGE;
}

async function readSavedQuota(response: Response, fallback: number | null): Promise<number | null> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "quotaBytes" in body) {
    const { quotaBytes } = body;
    if (quotaBytes === null || typeof quotaBytes === "number") return quotaBytes;
  }
  return fallback;
}

type RowStatus = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

function StorageQuotaRow({ user }: { user: UserStorage }) {
  const [quotaBytes, setQuotaBytes] = useState<number | null>(user.quotaBytes);
  const [megabytes, setMegabytes] = useState(() => initialMegabytes(user.quotaBytes));
  const [unlimited, setUnlimited] = useState(user.quotaBytes === null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });

  const tone = storageUsageTone({ usedBytes: user.usedBytes, quotaBytes });
  const inputId = `storage-quota-${user.id}`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    let quotaMb: number | null = null;
    if (!unlimited) {
      const trimmed = megabytes.trim();
      quotaMb = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
      if (quotaMb <= 0) {
        setStatus({ kind: "error", message: INVALID_QUOTA_MESSAGE });
        return;
      }
    }

    setSaving(true);
    setStatus({ kind: "idle" });
    try {
      const response = await fetch("/api/admin/storage-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, quotaMb }),
      });

      if (response.ok) {
        setQuotaBytes(await readSavedQuota(response, quotaBytes));
        setStatus({ kind: "saved" });
      } else {
        setStatus({ kind: "error", message: await readErrorMessage(response) });
      }
    } catch (err) {
      Sentry.captureException(err, {
        extra: { where: "admin-storage-list:save", userId: user.id },
      });
      setStatus({ kind: "error", message: SAVE_FAILED_MESSAGE });
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-border border-t align-top" data-testid={`storage-row-${user.id}`}>
      <td className="text-fg max-w-48 truncate px-3 py-3 text-sm font-medium">{user.email}</td>
      <td className={`px-3 py-3 text-sm whitespace-nowrap ${USAGE_TONE_CLASS[tone]}`}>
        {formatMegabytes(user.usedBytes)}
      </td>
      <td className="px-3 py-3 text-sm">
        <form className="flex flex-col gap-2" onSubmit={handleSubmit} noValidate>
          <p className="text-fg-muted text-xs">Current: {formatQuota(quotaBytes)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              Quota in MB for {user.email}
            </label>
            <Input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              inputSize="sm"
              className="w-24"
              value={megabytes}
              disabled={unlimited || saving}
              onChange={(event) => {
                setMegabytes(event.target.value);
                setStatus({ kind: "idle" });
              }}
            />
            <span className="text-fg-muted text-xs" aria-hidden="true">
              MB
            </span>
            <label className="text-fg flex cursor-pointer items-center gap-1 text-xs">
              <input
                type="checkbox"
                className="accent-primary-600"
                checked={unlimited}
                disabled={saving}
                aria-label={`Unlimited storage for ${user.email}`}
                onChange={(event) => {
                  setUnlimited(event.target.checked);
                  setStatus({ kind: "idle" });
                }}
              />
              <span aria-hidden="true">Unlimited</span>
            </label>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              loading={saving}
              aria-label={`Save quota for ${user.email}`}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
          {status.kind === "saved" && (
            <p className="text-success-text text-xs" role="status">
              Saved
            </p>
          )}
          {status.kind === "error" && (
            <p className="text-error-text text-xs" role="alert">
              {status.message}
            </p>
          )}
        </form>
      </td>
    </tr>
  );
}

/**
 * Per-user attachment storage on the admin page (issue #794): what each user has used,
 * and a quota editor in whole MB or Unlimited. The database enforces the quota.
 */
export function AdminStorageList({ users }: { users: UserStorage[] }) {
  return (
    <section className="mt-10" aria-labelledby="admin-storage-heading">
      <h2 id="admin-storage-heading" className="text-fg mb-3 text-lg font-semibold">
        Storage quotas
      </h2>
      {users.length === 0 ? (
        <p className="text-fg-muted text-sm">No users.</p>
      ) : (
        <Card shadow="sm" className="overflow-x-auto">
          <table className="w-full text-left" data-testid="admin-storage-table">
            <thead>
              <tr>
                <th scope="col" className="text-fg-muted px-3 py-2 text-xs font-medium">
                  User
                </th>
                <th scope="col" className="text-fg-muted px-3 py-2 text-xs font-medium">
                  Storage used
                </th>
                <th scope="col" className="text-fg-muted px-3 py-2 text-xs font-medium">
                  Quota
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <StorageQuotaRow key={user.id} user={user} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
