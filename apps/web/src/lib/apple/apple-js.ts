/**
 * On-demand loader for Sign in with Apple JS, which the web uses in popup mode to
 * ask an Apple-linked user to confirm before their account is deleted, so the
 * server can revoke Drafto's Apple tokens.
 *
 * The script is loaded only when it is needed: when an Apple-linked user opens
 * the delete dialog on drafto.eu. Loading it sends the user's IP address and
 * browser details to Apple, which the privacy policy discloses.
 */

export const APPLE_JS_SDK_URL =
  "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

/** The options Drafto passes to `AppleID.auth.init`. No `scope`: Apple asks for no name or email. */
export interface AppleIdAuthInitOptions {
  clientId: string;
  redirectURI: string;
  state: string;
  usePopup: true;
}

/** What `AppleID.auth.signIn()` resolves with in popup mode. */
export interface AppleIdSignInResponse {
  authorization: {
    code: string;
    id_token?: string;
    state?: string;
  };
}

/** The part of `AppleID.auth` Drafto uses. */
export interface AppleIdAuth {
  init(options: AppleIdAuthInitOptions): void;
  /** Rejects with `{ error: "popup_closed_by_user" }` when the user closes the popup. */
  signIn(): Promise<AppleIdSignInResponse>;
}

function readAppleIdAuth(): AppleIdAuth | null {
  if (typeof window === "undefined") return null;
  const appleId: unknown = (window as Window & { AppleID?: unknown }).AppleID;
  if (typeof appleId !== "object" || appleId === null) return null;
  const auth: unknown = (appleId as { auth?: unknown }).auth;
  if (typeof auth !== "object" || auth === null) return null;
  const { init, signIn } = auth as { init?: unknown; signIn?: unknown };
  if (typeof init !== "function" || typeof signIn !== "function") return null;
  return auth as AppleIdAuth;
}

let pendingLoad: Promise<AppleIdAuth | null> | null = null;

/**
 * The API if the script has already loaded, else `null`. Synchronous, so a click
 * handler can open Apple's popup without awaiting anything first (an `await`
 * before `signIn()` would let the browser's popup blocker stop it).
 */
export function getLoadedAppleIdAuth(): AppleIdAuth | null {
  return readAppleIdAuth();
}

/**
 * Loads Apple's script once and resolves its API, or `null` when it fails to load
 * (offline, blocked by an extension). Concurrent calls share one request; a failed
 * load is forgotten, so the next call tries again.
 */
export function loadAppleIdAuth(): Promise<AppleIdAuth | null> {
  const loaded = readAppleIdAuth();
  if (loaded) return Promise.resolve(loaded);
  if (typeof document === "undefined") return Promise.resolve(null);
  if (pendingLoad) return pendingLoad;

  const load = new Promise<AppleIdAuth | null>((resolve) => {
    const script = document.createElement("script");
    script.src = APPLE_JS_SDK_URL;
    script.async = true;
    script.onload = () => resolve(readAppleIdAuth());
    script.onerror = () => {
      script.remove();
      resolve(null);
    };
    document.head.appendChild(script);
  }).then((api) => {
    if (!api) pendingLoad = null;
    return api;
  });
  pendingLoad = load;
  return load;
}
