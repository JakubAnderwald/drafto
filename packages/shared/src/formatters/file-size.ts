const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Binary steps, as the storage quota counts: 1 KB = 1024 bytes. */
const STEP = 1024;

/** KB stay whole; MB and up keep one decimal below 100 ("1.2 MB", "120 MB"). */
function formatUnitValue(value: number, unit: number): string {
  if (unit <= 1 || value >= 100) return String(Math.round(value));
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * A file size for display next to an attachment: "512 B", "812 KB", "1.2 MB",
 * "1 GB". A value that rounds up to the next unit moves to it ("1 MB", never
 * "1024 KB"). A size that isn't a finite, non-negative number has no display
 * and returns "".
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  let text = formatUnitValue(value, unit);
  if (Number(text) >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
    text = formatUnitValue(value, unit);
  }
  return `${text} ${UNITS[unit]}`;
}
