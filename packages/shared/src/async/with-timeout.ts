/**
 * Resolves with `promise`'s value, or with `fallback` once `ms` have passed or
 * if `promise` rejects. Never rejects, so a caller bounded by it can never be
 * stranded by a reply that never comes (e.g. a WebView bridge round trip).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
