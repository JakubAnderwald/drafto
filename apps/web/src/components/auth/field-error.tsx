interface FieldErrorProps {
  /** Referenced by the field's `aria-describedby`, and the element's test id. */
  id: string;
  message?: string;
}

/**
 * An auth form's inline error under one field (PrimeTestLab 11035 M-02). Renders nothing without
 * a message. The field points at it with `aria-describedby` and sets `aria-invalid`, and the form
 * focuses the first invalid field, so a screen reader reads the error with the field.
 */
export function FieldError({ id, message }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p id={id} data-testid={id} className="text-error mt-1 text-sm">
      {message}
    </p>
  );
}
