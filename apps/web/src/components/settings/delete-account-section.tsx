"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import {
  ACCOUNT_DELETE_CONFIRMATION,
  describeAccountDeletionFailure,
  requestAccountDeletion,
} from "@drafto/shared";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";

const DELETE_ACCOUNT_LABEL = "Delete account";
const DELETE_ACCOUNT_WARNING =
  "This permanently deletes your Drafto account and all of your notebooks, notes and attachments. This cannot be undone.";
const CONFIRMATION_PROMPT = `Type ${ACCOUNT_DELETE_CONFIRMATION} to confirm`;
const ACCOUNT_DELETED_URL = "/login?deleted=1";

/**
 * Ends the browser session after the server has deleted the account. `local`
 * scope only clears this browser: the server already ended every session when
 * it deleted the user. A failure here must not strand the user on a settings
 * page for an account that no longer exists, so it is reported and ignored.
 */
async function signOutLocally(): Promise<void> {
  try {
    const { error } = await createClient().auth.signOut({ scope: "local" });
    if (error) {
      Sentry.captureException(error, { extra: { where: "delete-account-section:signOut" } });
    }
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "delete-account-section:signOut" } });
  }
}

export interface DeleteAccountSectionProps {
  className?: string;
}

export function DeleteAccountSection({ className }: DeleteAccountSectionProps) {
  const router = useRouter();
  const inputId = useId();
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = !pending && confirmation.trim() === ACCOUNT_DELETE_CONFIRMATION;

  function closeDialog() {
    // The request is already on its way; closing the dialog would hide its outcome.
    if (pending) return;
    setConfirming(false);
    setConfirmation("");
    setError(null);
  }

  async function handleConfirm() {
    if (!canConfirm) return;
    setPending(true);
    setError(null);

    const result = await requestAccountDeletion({ baseUrl: "" });
    if (result.status !== "ok") {
      setError(describeAccountDeletionFailure(result));
      setPending(false);
      return;
    }

    // Stay pending until the redirect lands, so the confirm button can't fire twice.
    await signOutLocally();
    router.replace(ACCOUNT_DELETED_URL);
  }

  return (
    <Card className={cn("border-error border", className)} data-testid="delete-account-section">
      <CardHeader>
        <h2 className="text-error text-lg font-semibold">{DELETE_ACCOUNT_LABEL}</h2>
        <p className="text-fg-muted text-sm">{DELETE_ACCOUNT_WARNING}</p>
      </CardHeader>
      <CardBody>
        {confirming ? (
          <ConfirmDialog
            title="Delete your account?"
            confirmLabel={DELETE_ACCOUNT_LABEL}
            cancelLabel="Cancel"
            variant="danger"
            error={error}
            loading={pending}
            confirmDisabled={!canConfirm}
            onConfirm={handleConfirm}
            onCancel={closeDialog}
          >
            <p className="mb-3">{DELETE_ACCOUNT_WARNING}</p>
            <Label htmlFor={inputId} className="mb-1 block">
              {CONFIRMATION_PROMPT}
            </Label>
            <Input
              id={inputId}
              inputSize="sm"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={confirmation}
              disabled={pending}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </ConfirmDialog>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {DELETE_ACCOUNT_LABEL}
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
