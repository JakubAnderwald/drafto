"use client";

import { useState, type FormEvent } from "react";
import * as Sentry from "@sentry/nextjs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_CONTENT_QUOTA_BYTES,
  DEFAULT_STORAGE_QUOTA_BYTES,
  bytesToMegabytes,
  formatMegabytes,
  storageUsageTone,
  type StorageUsage,
  type StorageUsageTone,
} from "@drafto/shared";

export interface UserStorage {
  id: string;
  email: string;
  usedBytes: number;
  /** null = unlimited. */
  quotaBytes: number | null;
  /** Note content usage and quota (ADR 0090); null or absent when it couldn't be loaded. */
  content?: StorageUsage | null;
}

const SAVE_FAILED_MESSAGE = "Failed to save the quota. Please try again.";
const INVALID_QUOTA_MESSAGE = "Enter a whole number of MB greater than 0, or tick Unlimited.";

const USAGE_TONE_CLASS: Record<StorageUsageTone, string> = {
  default: "text-fg",
  warning: "text-warning-text",
  danger: "text-error-text",
};

/** Which quota a pair of cells edits: the request field and response key differ. */
interface QuotaKind {
  /** The `POST /api/admin/storage-quota` body field. */
  field: "quotaMb" | "contentQuotaMb";
  /** The response key holding the saved quota in bytes. */
  responseKey: "quotaBytes" | "contentQuotaBytes";
  defaultQuotaBytes: number;
  idPrefix: string;
  /** The `where` of a failed save's Sentry report. */
  sentryWhere: string;
  inputLabel: (email: string) => string;
  unlimitedLabel: (email: string) => string;
  saveLabel: (email: string) => string;
}

const STORAGE_KIND: QuotaKind = {
  field: "quotaMb",
  responseKey: "quotaBytes",
  defaultQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
  idPrefix: "storage-quota",
  sentryWhere: "admin-storage-list:save",
  inputLabel: (email) => `Quota in MB for ${email}`,
  unlimitedLabel: (email) => `Unlimited storage for ${email}`,
  saveLabel: (email) => `Save quota for ${email}`,
};

const CONTENT_KIND: QuotaKind = {
  field: "contentQuotaMb",
  responseKey: "contentQuotaBytes",
  defaultQuotaBytes: DEFAULT_CONTENT_QUOTA_BYTES,
  idPrefix: "content-quota",
  sentryWhere: "admin-storage-list:save-content",
  inputLabel: (email) => `Notes quota in MB for ${email}`,
  unlimitedLabel: (email) => `Unlimited notes for ${email}`,
  saveLabel: (email) => `Save notes quota for ${email}`,
};

/** The number the quota input starts at: the quota in whole MB, or the default for unlimited. */
function initialMegabytes(quotaBytes: number | null, defaultQuotaBytes: number): string {
  const bytes = quotaBytes ?? defaultQuotaBytes;
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

async function readSavedQuota(
  response: Response,
  key: QuotaKind["responseKey"],
  fallback: number | null,
): Promise<number | null> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (value === null || typeof value === "number") return value;
  }
  return fallback;
}

type RowStatus = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

interface QuotaCellsProps {
  userId: string;
  email: string;
  usage: StorageUsage;
  kind: QuotaKind;
}

/** Two table cells for one quota: what the user has used, and the quota editor. */
function QuotaCells({ userId, email, usage, kind }: Readonly<QuotaCellsProps>) {
  const [quotaBytes, setQuotaBytes] = useState<number | null>(usage.quotaBytes);
  const [megabytes, setMegabytes] = useState(() =>
    initialMegabytes(usage.quotaBytes, kind.defaultQuotaBytes),
  );
  const [unlimited, setUnlimited] = useState(usage.quotaBytes === null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<RowStatus>({ kind: "idle" });

  const tone = storageUsageTone({ usedBytes: usage.usedBytes, quotaBytes });
  const inputId = `${kind.idPrefix}-${userId}`;

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
        body: JSON.stringify({ userId, [kind.field]: quotaMb }),
      });

      if (response.ok) {
        setQuotaBytes(await readSavedQuota(response, kind.responseKey, quotaBytes));
        setStatus({ kind: "saved" });
      } else {
        setStatus({ kind: "error", message: await readErrorMessage(response) });
      }
    } catch (err) {
      Sentry.captureException(err, {
        extra: { where: kind.sentryWhere, userId },
      });
      setStatus({ kind: "error", message: SAVE_FAILED_MESSAGE });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <td className={`px-3 py-3 text-sm whitespace-nowrap ${USAGE_TONE_CLASS[tone]}`}>
        {formatMegabytes(usage.usedBytes)}
      </td>
      <td className="px-3 py-3 text-sm">
        <form className="flex flex-col gap-2" onSubmit={handleSubmit} noValidate>
          <p className="text-fg-muted text-xs">Current: {formatQuota(quotaBytes)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              {kind.inputLabel(email)}
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
                aria-label={kind.unlimitedLabel(email)}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setUnlimited(checked);
                  // Unticking offers the row's current quota, or the default when it is
                  // Unlimited, never a stale number typed before an earlier save.
                  if (!checked) setMegabytes(initialMegabytes(quotaBytes, kind.defaultQuotaBytes));
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
              aria-label={kind.saveLabel(email)}
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
    </>
  );
}

function StorageQuotaRow({ user }: Readonly<{ user: UserStorage }>) {
  return (
    <tr className="border-border border-t align-top" data-testid={`storage-row-${user.id}`}>
      <td className="text-fg max-w-48 truncate px-3 py-3 text-sm font-medium">{user.email}</td>
      <QuotaCells
        userId={user.id}
        email={user.email}
        usage={{ usedBytes: user.usedBytes, quotaBytes: user.quotaBytes }}
        kind={STORAGE_KIND}
      />
      {user.content ? (
        <QuotaCells userId={user.id} email={user.email} usage={user.content} kind={CONTENT_KIND} />
      ) : (
        <td className="text-fg-muted px-3 py-3 text-sm" colSpan={2}>
          Unavailable
        </td>
      )}
    </tr>
  );
}

/**
 * Per-user attachment storage (issue #794) and note content (ADR 0090) on the admin
 * page: what each user has used, and a quota editor for each in whole MB or Unlimited.
 * The database enforces both quotas.
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
                <th scope="col" className="text-fg-muted px-3 py-2 text-xs font-medium">
                  Notes used
                </th>
                <th scope="col" className="text-fg-muted px-3 py-2 text-xs font-medium">
                  Notes quota
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
