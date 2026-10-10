/**
 * True on a Mac desktop browser — the only place the Drafto Mac app can be
 * installed, so the only place the hand-off page should launch it on its own.
 *
 * iPadOS Safari in desktop mode also reports "Macintosh", but it has a
 * multi-touch screen, so `maxTouchPoints > 1` rules it out.
 */
export function isMacDesktop(userAgent: string, maxTouchPoints: number): boolean {
  return /Macintosh/.test(userAgent) && maxTouchPoints <= 1;
}
