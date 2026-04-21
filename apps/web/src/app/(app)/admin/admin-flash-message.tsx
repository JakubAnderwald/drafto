interface AdminFlashMessageProps {
  approved?: string;
  error?: string;
}

const approvedMessages: Record<string, string> = {
  approved: "User approved. They've been emailed and can sign in now.",
  approved_email_failed:
    "User approved, but the confirmation email failed to send. They can still sign in — reach out manually if needed.",
  already_approved: "That user was already approved. No action taken.",
};

const errorMessages: Record<string, string> = {
  missing_token: "The approval link was missing its token.",
  invalid_or_expired_token:
    "The approval link is invalid or has expired. Try approving from the list below.",
  forbidden: "You need to be signed in as an admin to use an approval link.",
  update_failed: "Something went wrong while approving that user. Try again.",
  user_not_found: "That user no longer exists.",
};

export function AdminFlashMessage({ approved, error }: AdminFlashMessageProps) {
  if (approved) {
    const message = approvedMessages[approved] ?? approvedMessages.approved;
    const isWarning = approved === "approved_email_failed";
    const tone = isWarning ? "warning" : "success";
    return (
      <div
        role="status"
        data-testid="admin-flash-success"
        data-tone={tone}
        className={
          isWarning
            ? "bg-warning-bg text-warning-text mb-4 rounded-lg px-4 py-3 text-sm"
            : "bg-success-bg text-success-text mb-4 rounded-lg px-4 py-3 text-sm"
        }
      >
        {message}
      </div>
    );
  }

  if (error) {
    const message = errorMessages[error] ?? "Something went wrong.";
    return (
      <div
        role="alert"
        data-testid="admin-flash-error"
        className="bg-error-bg text-error-text mb-4 rounded-lg px-4 py-3 text-sm"
      >
        {message}
      </div>
    );
  }

  return null;
}
