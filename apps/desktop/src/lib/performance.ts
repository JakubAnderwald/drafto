/**
 * Lightweight performance measurement utilities for profiling
 * startup time and sync operations.
 */

interface PerfMark {
  label: string;
  timestamp: number;
}

interface PerfMeasurement {
  label: string;
  durationMs: number;
}

const marks: PerfMark[] = [];
const measurements: PerfMeasurement[] = [];
let startupStart: number | null = null;

export function markStartupBegin(): void {
  startupStart = Date.now();
  marks.length = 0;
  measurements.length = 0;
  marks.push({ label: "startup_begin", timestamp: startupStart });
}

export function markStartupEnd(): void {
  const now = Date.now();
  marks.push({ label: "startup_end", timestamp: now });

  if (startupStart !== null) {
    const duration = now - startupStart;
    measurements.push({ label: "startup", durationMs: duration });

    if (__DEV__) {
      console.log(`[Perf] Startup: ${duration}ms`);
      if (duration > 2000) {
        console.warn(`[Perf] Startup exceeded 2s target (${duration}ms)`);
      }
    }
  }
}

export function mark(label: string): void {
  marks.push({ label, timestamp: Date.now() });
}

export function measure(label: string, startLabel: string, endLabel: string): number | null {
  const start = marks.find((m) => m.label === startLabel);
  const end = marks.find((m) => m.label === endLabel);

  if (!start || !end) return null;

  const duration = end.timestamp - start.timestamp;
  measurements.push({ label, durationMs: duration });

  if (__DEV__) {
    console.log(`[Perf] ${label}: ${duration}ms`);
  }

  return duration;
}

export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - start;
    measurements.push({ label, durationMs: duration });

    if (__DEV__) {
      console.log(`[Perf] ${label}: ${duration}ms`);
    }
  }
}

export function getMarks(): readonly PerfMark[] {
  return marks;
}

export function getMeasurements(): readonly PerfMeasurement[] {
  return measurements;
}

export function getStartupDuration(): number | null {
  const startup = measurements.find((m) => m.label === "startup");
  return startup?.durationMs ?? null;
}

export function clearPerformanceData(): void {
  marks.length = 0;
  measurements.length = 0;
  startupStart = null;
}
