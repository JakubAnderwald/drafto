/** Routes app/_layout.tsx presents as modals (`presentation: "modal"`). */
export const MODAL_ROUTES: ReadonlySet<string> = new Set(["search"]);

interface StackRoute {
  key: string;
  name: string;
}

/**
 * Whether a route sits above a modal in the root stack.
 *
 * On iOS, react-native-screens presents every screen pushed above a modal as a
 * modal too: a sheet of its own, whose first screen has no back button. A note
 * opened from Search (or from a link while Search is open) is one of these.
 */
export function isAboveModal(routes: readonly StackRoute[], key: string): boolean {
  const index = routes.findIndex((route) => route.key === key);
  return routes.slice(0, Math.max(index, 0)).some((route) => MODAL_ROUTES.has(route.name));
}
