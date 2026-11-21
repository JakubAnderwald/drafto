"use client";

import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRelativeTime } from "@drafto/shared";

export interface AdminAccount {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  /** `profiles.is_approved`: false for a signup never activated or a suspended account. */
  is_active: boolean;
  is_admin: boolean;
}

/** What a row's in-flight request is doing, if anything. */
export type AccountBusy = "activating" | "suspending" | "deleting";

/** The one confirmation that can be open at a time. */
export type AccountConfirm = "suspend" | "delete";

export interface AdminAccountRowProps {
  account: AdminAccount;
  busy: AccountBusy | null;
  confirming: AccountConfirm | null;
  confirmError: string | null;
  /** Why this row's last Activate failed, if it did. */
  activateError: string | null;
  /** True while another row's suspend or delete is in flight: one confirmed action at a time. */
  confirmLocked: boolean;
  onActivate: () => void;
  onRequestConfirm: (action: AccountConfirm) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}

const CONFIRM_COPY: Record<
  AccountConfirm,
  { title: string; label: string; body: (email: string) => string }
> = {
  suspend: {
    title: "Suspend user?",
    label: "Suspend",
    body: (email) =>
      `${email} loses access to their notes on every device until you reactivate them. Nothing is deleted.`,
  },
  delete: {
    title: "Delete user?",
    label: "Delete",
    body: (email) =>
      `This permanently deletes ${email} and all of their data. This cannot be undone. Only an account with no notebooks, notes or API keys can be deleted here.`,
  },
};

export function AdminAccountRow({
  account,
  busy,
  confirming,
  confirmError,
  activateError,
  confirmLocked,
  onActivate,
  onRequestConfirm,
  onConfirm,
  onCancelConfirm,
}: AdminAccountRowProps) {
  const isBusy = busy !== null;

  return (
    <li>
      <Card shadow="sm">
        <CardBody>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-fg truncate font-medium">{account.email}</p>
              <p className="text-fg-muted truncate text-sm">
                {account.display_name ? `${account.display_name} · ` : ""}
                Signed up {formatRelativeTime(account.created_at)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {account.is_admin ? (
                <Badge>Admin</Badge>
              ) : account.is_active ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === "suspending"}
                  disabled={isBusy || confirmLocked}
                  onClick={() => onRequestConfirm("suspend")}
                >
                  {busy === "suspending" ? "Suspending..." : "Suspend"}
                </Button>
              ) : (
                <>
                  <Button
                    variant="success"
                    size="sm"
                    loading={busy === "activating"}
                    disabled={busy === "deleting"}
                    onClick={onActivate}
                  >
                    {busy === "activating" ? "Activating..." : "Activate"}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === "deleting"}
                    disabled={isBusy || confirmLocked}
                    onClick={() => onRequestConfirm("delete")}
                  >
                    {busy === "deleting" ? "Deleting..." : "Delete"}
                  </Button>
                </>
              )}
            </div>
          </div>
          {activateError && (
            <p className="text-error-text mt-2 text-sm" role="alert">
              {activateError}
            </p>
          )}
          {confirming && (
            <ConfirmDialog
              className="mt-3"
              title={CONFIRM_COPY[confirming].title}
              confirmLabel={CONFIRM_COPY[confirming].label}
              cancelLabel="Cancel"
              variant={confirming === "delete" ? "danger" : "warning"}
              error={confirmError}
              loading={busy === "suspending" || busy === "deleting"}
              onConfirm={onConfirm}
              onCancel={onCancelConfirm}
            >
              {CONFIRM_COPY[confirming].body(account.email)}
            </ConfirmDialog>
          )}
        </CardBody>
      </Card>
    </li>
  );
}
