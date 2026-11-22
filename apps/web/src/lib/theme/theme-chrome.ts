/**
 * The browser chrome around the page (address bar, status bar, form controls, scroll bars)
 * follows the in-app theme, not the OS setting (#865).
 *
 * `color-scheme` follows the `.dark` class on `<html>` through `globals.css`. The
 * `<meta name="theme-color">` is created and set here, from the same resolved theme: by the
 * inline bootstrap script before first paint, and by `use-theme.ts` afterwards. React never
 * renders it: React 19 hoists `<meta>`, so a server-rendered one whose content the script changed
 * no longer matches at hydration, and React adds a second one beside it.
 */

export type ResolvedTheme = "light" | "dark";

/** The `localStorage` key holding the user's choice: `"light"`, `"dark"` or `"system"`. */
export const THEME_STORAGE_KEY = "theme";

/** The `--bg` token for each mode in `globals.css`; a unit test keeps the two in step. */
export const THEME_COLOR: Readonly<Record<ResolvedTheme, string>> = {
  light: "#fff8f5",
  dark: "#1f1b17",
};

const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';

/** Points the `theme-color` meta at the resolved theme's background, adding it if missing. */
export function syncThemeColorMeta(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  let meta = document.querySelector<HTMLMetaElement>(THEME_COLOR_SELECTOR);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = THEME_COLOR[resolved];
}

/**
 * The inline script the root layout runs in `<head>`, before the body is parsed: it sets the
 * `dark` class and adds the `theme-color` meta from the stored choice, so the first paint
 * already matches. The same steps as `syncThemeColorMeta`, in plain ES5.
 */
export function buildThemeBootstrapScript(): string {
  const key = JSON.stringify(THEME_STORAGE_KEY);
  const selector = JSON.stringify(THEME_COLOR_SELECTOR);
  const light = JSON.stringify(THEME_COLOR.light);
  const dark = JSON.stringify(THEME_COLOR.dark);
  return (
    // Each read is guarded on its own (storage can be blocked, matchMedia missing), so the page
    // always gets the class and a meta: a failed read counts as "not dark".
    `(function(){var t=null,s=false;` +
    `try{t=localStorage.getItem(${key})}catch(e){}` +
    `try{s=matchMedia("(prefers-color-scheme:dark)").matches}catch(e){}` +
    `var d=t==="dark"||(t!=="light"&&s);` +
    `try{if(d)document.documentElement.classList.add("dark");` +
    `var m=document.querySelector(${selector});` +
    `if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m)}` +
    `m.content=d?${dark}:${light}` +
    `}catch(e){}})()`
  );
}
