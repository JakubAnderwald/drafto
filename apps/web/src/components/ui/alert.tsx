import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface AlertAction {
  label: string;
  onClick: () => void;
}

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  children: ReactNode;
  // Shows a "Dismiss" button when set.
  onDismiss?: () => void;
  // An optional action next to the message, e.g. Retry.
  action?: AlertAction;
}

const buttonStyles =
  "text-error-text shrink-0 rounded-sm text-xs font-medium underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error";

// An inline error message: the same look as the editor's upload error and the auth forms'
// errors, with an optional action and Dismiss button.
export function Alert({ children, onDismiss, action, className, ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cn(
        "bg-error-bg text-error-text flex items-start gap-3 rounded-md px-3 py-2 text-sm",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action && (
        <button type="button" className={buttonStyles} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className={buttonStyles} onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
