import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Next looks for the middleware next to the app directory, and the app router lives in
// `src/app`. A `middleware.ts` at the web root still worked in production, because
// `next build` finds it there, but `next dev` compiled it and never ran it: local dev had
// no session gate, no landing-page rewrite of signed-out `/`, and no overwrite of the
// `x-verified-*` headers.
// `import.meta.url` is an http: URL under jsdom, so resolve from the file path instead.
const WEB_ROOT = path.resolve(__dirname, "../..");
const EXTENSIONS = ["ts", "tsx", "mts", "js", "jsx", "mjs"];

function filesIn(dir: string, name: string): string[] {
  return EXTENSIONS.map((ext) => `${name}.${ext}`).filter((file) =>
    existsSync(path.join(dir, file)),
  );
}

describe("Next.js convention files", () => {
  it("keeps the app router under src/", () => {
    expect(existsSync(path.join(WEB_ROOT, "src/app"))).toBe(true);
  });

  it("keeps the middleware under src/, next to the app router", () => {
    const found = ["middleware", "proxy"].flatMap((name) =>
      filesIn(path.join(WEB_ROOT, "src"), name),
    );
    expect(found).not.toEqual([]);
  });

  it.each(["middleware", "proxy"])(
    "has no %s file at the web root, where next dev ignores it",
    (name) => {
      expect(filesIn(WEB_ROOT, name)).toEqual([]);
    },
  );
});
