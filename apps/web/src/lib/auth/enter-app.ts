// Opens the app after a client-side sign-in. It does a full page load, not a router push: signed
// out, `/` is the landing page (a middleware rewrite), and the client router may still map `/` to
// it. A fresh request lets middleware pick the page that matches the new session cookie, the same
// way the OAuth and email-link sign-ins arrive through /auth/callback.
export function enterApp(): void {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- the full page load is the point: a router push can reuse the cached landing page for `/`
  window.location.assign("/");
}
