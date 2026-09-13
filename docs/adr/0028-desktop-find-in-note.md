# 0028 — Desktop Find-in-Note (and the macOS Cmd+F crash)

- **Status**: Accepted
- **Date**: 2026-07-06
- **Authors**: Jakub Anderwald

## Context

Pressing **Cmd+F** in the macOS app (react-native-macos) crashed it instantly. A
native crash report showed a `SIGABRT` from an `NSInvalidArgumentException`
(`-[__NSPlaceholderArray initWithObjects:count:]: attempt to insert nil object`)
thrown inside react-native-macos core, reached via
`-[WKWebView _web_superKeyDown:]` → the responder chain. It is **not** a
JavaScript error.

Root cause: the note editor is `@10play/tentap-editor` (TipTap/ProseMirror in a
`react-native-webview` WKWebView). When the web content doesn't consume a key,
WebKit forwards it up the native responder chain, where react-native-macos's
key handling builds an `NSArray` with a `nil` element and aborts. Normally
AppKit's default main menu binds Cmd+F to Edit ▸ Find, absorbing it as a menu
key-equivalent before it can reach the WebView. But `DraftoMenuManager.setupMenus`
**replaces the entire main menu** (`[NSApp setMainMenu:]`) with a custom menu that
had **no Find item**, so Cmd+F leaked to the WebView and triggered the crash.

There was no find-in-note feature on any platform, so the natural fix — bind
Cmd+F — also had to decide what Cmd+F should _do_.

## Decision

1. **Bind the find shortcuts natively.** `DraftoMenuManager.buildEditMenu` now
   includes an Edit ▸ Find submenu with **Find… (Cmd+F)**, **Find Next (Cmd+G)**,
   and **Find Previous (Cmd+Shift+G)**, wired through the existing
   `handleMenuAction:` → `onMenuAction` bridge (target = the menu manager). A
   concrete target keeps each item enabled, so its key-equivalent always fires
   during `performKeyEquivalent:` and the key never reaches the WebView. This is
   the root-cause crash fix.

   > **Invariant for future maintainers:** any editor keyboard shortcut that the
   > WebView does not consume MUST be bound as a menu key-equivalent (or otherwise
   > intercepted before `keyDown:`). Dropping a binding re-exposes the
   > react-native-macos forwarded-key crash.

2. **Implement find-in-note on desktop** driven from that menu action. The panel
   opens a `FindBar` and injects a small engine (`find-engine.ts`,
   `window.__draftoFind`) into the tentap WebView via
   `webviewRef.current.injectJavaScript(...)`. The engine highlights matches with
   the **CSS Custom Highlight API** (`CSS.highlights` + `Highlight`/`Range`),
   which overlays ranges **without mutating the ProseMirror DOM** — so find never
   edits the document, fires tentap's `onChange`, or risks corrupting content.
   Match counts are posted back with `ReactNativeWebView.postMessage` and read via
   a custom `onMessage` passthrough on `<RichText>` with
   `exclusivelyUseCustomOnMessage={false}` — that prop defaults to `true` in
   tentap 1.0.1, so leaving it unset while supplying a custom `onMessage` would
   suppress tentap's own bridge handling (readiness, onChange, getJSON) and break
   the editor.

Scope is **desktop-only** (`parity:desktop-only`): the crash is
macOS-native-menu specific.

## Consequences

- **Positive**: Cmd+F no longer crashes; users get find-in-note with highlight,
  next/previous, and a live match count. The highlight approach can't corrupt note
  content (no DOM mutation, no autosave trigger). The `onMessage` passthrough is a
  reusable channel for future app-defined WebView messages.
- **Negative**: find-in-note is not yet on mobile/web (tracked as follow-up). The
  engine matches within a single text node, so a phrase split across formatting
  boundaries won't match. Other unbound Cmd-shortcuts pressed while the editor is
  focused could still hit the same react-native-macos crash path (most common
  ones are already menu-bound).
- **Neutral**: find state lives in `NoteEditorPanel`; the menu action reaches it
  via a `findSignal` nonce prop threaded from `main.tsx`.

## Alternatives Considered

- **`window.find()`** instead of the Highlight API: simpler, but it mutates the
  document selection inside a contentEditable and gives no highlight-all or count.
  Kept as a documented fallback only.
- **Native `NSTextFinder` / `WKWebView.findString`**: the "proper" macOS find, but
  requires threading a native WKWebView reference out of react-native-webview and
  more native plumbing for counts; disproportionate for a v1.
- **Cmd+F opens the existing ⌘K note search**: absorbs the key and fixes the crash
  cheaply, but Cmd+F conventionally means find-in-current-document, so this would
  mislead users.
- **Patch react-native-macos** to guard the nil-array crash: addresses the whole
  key class, but the exact upstream line needs dSYM symbolication we don't have,
  and menu interception fixes the reported crash cleanly. Left as a possible
  follow-up.
