interface AdminFlashMessageProps {
  approved?: string;
  error?: string;
}

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
    return (
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        Approved <span className="font-semibold">{approved}</span>. They&rsquo;ve been emailed and
        can sign in now.
      </div>
    );
  }

  if (error) {
    const message = errorMessages[error] ?? "Something went wrong.";
    return (
      <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
        {message}
      </div>
    );
  }

  return null;
}
