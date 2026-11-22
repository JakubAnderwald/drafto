/**
 * @vitest-environment node
 */
import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The web ESLint config rejects a bare `text-primary-600` in a `className` with no `dark:text-*`
 * partner: the scale colours don't follow the theme, so such a link stays deep indigo on the dark
 * surfaces (#910). Lints probe snippets through the real config.
 */

const WEB_ROOT = path.resolve(__dirname, "../..");
const PROBE_PATH = path.join(WEB_ROOT, "src/app/__probe__.tsx");
const GUARD_MESSAGE = /text-primary-600 is unreadable on the dark surfaces/;

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: WEB_ROOT });
});

async function guardHits(jsx: string): Promise<number> {
  const source = `export function Probe({ on }: { on: boolean }) {\n  return ${jsx};\n}\n`;
  const [result] = await eslint.lintText(source, { filePath: PROBE_PATH });
  return result.messages.filter(
    (m) => m.ruleId === "no-restricted-syntax" && GUARD_MESSAGE.test(m.message),
  ).length;
}

describe("dark-mode link lint guard", () => {
  it("flags a bare text-primary-600 in a className string", async () => {
    expect(await guardHits(`<a className="text-primary-600 hover:underline">x</a>`)).toBe(1);
  }, 60_000);

  it("flags a bare text-primary-600 in a className template literal", async () => {
    expect(
      await guardHits("<a className={`text-primary-600 ${on ? 'font-bold' : ''}`}>x</a>"),
    ).toBe(1);
  }, 60_000);

  it("flags the old auth-page pair, which has no dark: colour", async () => {
    expect(
      await guardHits(
        `<a className="text-primary-600 hover:text-primary-700 hover:underline">x</a>`,
      ),
    ).toBe(1);
  }, 60_000);

  it("allows text-primary-600 with a dark:text-* partner in the same string", async () => {
    expect(await guardHits(`<a className="text-primary-600 dark:text-primary-300">x</a>`)).toBe(0);
  }, 60_000);

  it("doesn't count a dark: utility that isn't a colour as a partner", async () => {
    expect(await guardHits(`<a className="text-primary-600 dark:text-sm">x</a>`)).toBe(1);
    expect(await guardHits(`<a className="text-primary-600 dark:text-2xl">x</a>`)).toBe(1);
    expect(await guardHits(`<a className="text-primary-600 dark:text-center">x</a>`)).toBe(1);
    expect(await guardHits(`<a className="text-primary-600 dark:text-fg">x</a>`)).toBe(0);
  }, 60_000);

  it("reads a template literal as a whole", async () => {
    expect(
      await guardHits(
        "<a className={`text-primary-600 ${on ? 'font-bold' : ''} dark:text-primary-300`}>x</a>",
      ),
    ).toBe(0);
    expect(
      await guardHits(
        "<a className={`text-primary-600 ${on ? 'font-bold' : ''} dark:text-sm`}>x</a>",
      ),
    ).toBe(1);
  }, 60_000);

  it("allows the ui-link class", async () => {
    expect(await guardHits(`<a className="ui-link hover:underline">x</a>`)).toBe(0);
  }, 60_000);

  it("ignores variant-prefixed and other shades", async () => {
    expect(
      await guardHits(
        `<a className="text-fg hover:text-primary-600 text-primary-6000 bg-primary-600">x</a>`,
      ),
    ).toBe(0);
  }, 60_000);
});
