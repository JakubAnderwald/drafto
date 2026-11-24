interface FieldErrorProps {
  /** Referenced by the field's `aria-describedby`, and the element's test id. */
  id: string;
  message?: string;
}

/**
 * An auth form's inline error under one field (PrimeTestLab 11035 M-02). Renders nothing without
 * a message. It is an alert, so a screen reader announces it as it appears, even when the invalid
 * field already has focus and the form's focus() call changes nothing. The field also points at
 * it with `aria-describedby` and sets `aria-invalid`, so it is read again with the field.
 */
export function FieldError({ id, message }: Readonly<FieldErrorProps>) {
  if (!message) return null;
  return (
    <p id={id} data-testid={id} role="alert" className="text-error mt-1 text-sm">
      {message}
    </p>
  );
}
