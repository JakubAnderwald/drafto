/**
 * Hermes (React Native's JS engine) has two URL issues:
 * 1. URL.protocol is read-only — Supabase Realtime tries to assign it
 * 2. URL adds trailing slash to all pathnames — PostgREST rejects "/table/"
 *
 * This polyfill wraps the global URL via composition (not inheritance,
 * since Babel's super calls cause infinite recursion with Hermes URL).
 */

const OrigURL = globalThis.URL;

function stripTrailingSlash(href: string): string {
  // Remove trailing slash before query string, hash, or end of URL
  // But preserve root path "/" and protocol "://"
  return href.replace(/([^:/])\/(\?|#|$)/, "$1$2");
}

class PatchedURL {
  _inner: InstanceType<typeof OrigURL>;
  _protocolOverride?: string;

  constructor(url: string | URL, base?: string | URL) {
    // @ts-expect-error -- OrigURL constructor overloads
    this._inner = new OrigURL(url, base);
  }

  get protocol() {
    return this._protocolOverride ?? this._inner.protocol;
  }
  set protocol(v: string) {
    this._protocolOverride = v;
  }

  get pathname() {
    const p = this._inner.pathname;
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  }
  set pathname(v: string) {
    try {
      this._inner.pathname = v;
    } catch {
      /* Hermes read-only */
    }
  }

  get href() {
    const original = this._inner.href;
    let result = stripTrailingSlash(original);
    if (this._protocolOverride) {
      result = result.replace(/^[a-z]+:/, this._protocolOverride);
    }
    return result;
  }

  get host() {
    return this._inner.host;
  }
  get hostname() {
    return this._inner.hostname;
  }
  get port() {
    return this._inner.port;
  }
  get origin() {
    return this._inner.origin;
  }
  get username() {
    return this._inner.username;
  }
  get password() {
    return this._inner.password;
  }
  get hash() {
    return this._inner.hash;
  }
  set hash(v: string) {
    this._inner.hash = v;
  }
  get search() {
    return this._inner.search;
  }
  set search(v: string) {
    this._inner.search = v;
  }
  get searchParams() {
    return this._inner.searchParams;
  }

  toString() {
    return this.href;
  }
  toJSON() {
    return this.href;
  }
}

// @ts-expect-error -- replacing global URL
globalThis.URL = PatchedURL;
