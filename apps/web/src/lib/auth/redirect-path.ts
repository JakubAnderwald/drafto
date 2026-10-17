// Keeps a post-sign-in `next` redirect on this origin. Only a path that starts with a single
// `/` is kept; anything else (missing, absolute, or protocol-relative like `//evil.example`)
// becomes `/`.
//
// The prefix checks alone aren't enough: browsers and the WHATWG URL parser read `\` as `/`
// and drop tabs and newlines, so `/\evil.example` or `/<tab>/evil.example` (and `next=/%5C…`,
// which arrives decoded) still resolve to another host. So the path is resolved the way the
// redirect will be, and kept only if it stays on the same origin.
const BASE = "https://redirect-check.invalid";

export function sanitizeRedirectPath(path: string | null): string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return "/";
  }
  let resolved: URL;
  try {
    resolved = new URL(path, BASE);
  } catch {
    return "/";
  }
  return resolved.origin === BASE ? path : "/";
}
