# 0063 — Desktop Patches RN Native Bugs From the App Target

- **Status**: Accepted
- **Date**: 2026-10-31
- **Authors**: Jakub Anderwald, Claude

## Context

Drafto for macOS 0.4.4 (70) aborted on a key press in the note editor (`EXC_CRASH / SIGABRT`, an uncaught `NSInvalidArgumentException` from `+[NSArray arrayWithObjects:count:]`). Symbolicated against react-native-macos 0.81.6, the stack is:

```
WKWebView _web_superKeyDown:            ← a key the editor page didn't handle
-[RCTView keyDown:]
-[RCTView handleKeyboardEvent:]
+[RCTViewKeyboardEvent keyEventFromEvent:reactTag:]
-[RCTComponentEvent initWithName:viewTag:body:]   _arguments = @[ _viewTag, … ]  ← _viewTag is nil
```

The app runs the New Architecture. react-native-webview's Fabric component (`RNCWebView.mm`) creates its `RNCWebViewImpl` with a plain `-init`, and `RNCWebViewImpl` is a Paper `RCTView` subclass, so it never gets a `reactTag`. When WKWebView hands an unhandled key (Escape, an unbound shortcut) to `super`, Paper `RCTView` builds a component event with a nil tag, and the `@[]` literal throws. `RCTComponentEvent.m` and `RCTView.m` are unchanged on react-native-macos `0.83-stable`, so the upgrade in [#558](https://github.com/JakubAnderwald/drafto/issues/558) does not fix it by itself.

The normal fix is a `pnpm patch` of react-native-macos. Desktop can't take one: it builds only from the primary checkout's fossil `node_modules` ([ADR-0027](./0027-desktop-react-version-locked-to-react-native-macos.md)), and applying a patch means a `pnpm install`, which destroys the fossil. [ADR-0062](./0062-desktop-pkce-native-csprng.md) already puts new native _capabilities_ in the app target for the same reason. This decision covers native _bugs_ in code we don't own.

## Decision

Fix bugs in React Native's (or a native dependency's) Objective-C code with a targeted runtime patch compiled into the macOS app target (`apps/desktop/macos/Drafto-macOS/`, wired into `project.pbxproj`), never by editing the fossil's `node_modules`.

The first one is `DraftoKeyboardEventGuard.mm`. A category on `RCTView` replaces the implementation of `-handleKeyboardEvent:` once, in `+load`:

- If `self.reactTag` is nil, return `NO`. This emits nothing and blocks nothing, so `-keyDown:` calls `super` and the event bubbles on to the Fabric `RCTViewComponentView`. That view builds its event without a tag. A view without a tag has no JS listener and no `keyDownEvents`, so nothing is lost.
- Otherwise, call the original implementation.
- If the selector is missing, assert in Debug, and in Release log once and install nothing rather than crash.

Every such patch must:

1. Hook the narrowest method that fixes the bug, and call the original for every case it doesn't change.
2. Carry a header comment naming the crash or bug, the upstream code it works around, and a `TODO(#558)` removal condition.
3. Be listed on #558, so that moving off the fossil replaces it with a `pnpm patch` or deletes it.

## Consequences

- **Positive**: the crash is fixed in source that ships through the existing fossil build. No `node_modules` edit, no Podfile change, no `pod install`.
- **Positive**: the guard covers key events for every Paper `RCTView` hosted under Fabric that uses `RCTView`'s own `-handleKeyboardEvent:`, not just the webview. Paper subclasses that override it without calling `super` (such as `RCTScrollView`) aren't covered, but Fabric doesn't host them.
- **Neutral**: Paper `RCTView`'s `-becomeFirstResponder` and `-resignFirstResponder` build an `RCTFocusChangeEvent` from the same nil tag, and aren't guarded. `RNCWebViewImpl` never takes first responder: `acceptsFirstResponder` is `focusable || NSView's default`, both NO, and the webview hands focus to its inner `WKWebView`. A tagless Paper view that does take focus would need its own patch.
- **Negative**: runtime method replacement is less visible than a patch file, and it binds to a private-ish RN method by name. A future react-native-macos that renames `handleKeyboardEvent:` disables the guard. Debug builds assert at launch; Release only logs.
- **Negative**: it's fossil-driven tech debt. TODO(#558): once a clean install builds desktop, replace `DraftoKeyboardEventGuard.mm` and its 4 `project.pbxproj` entries with a `pnpm patch` of react-native-macos, or delete them if upstream guards nil `reactTag`. Then mark this ADR superseded.

## Alternatives Considered

- **`pnpm patch` react-native-macos or react-native-webview.** It's the right tool, but applying it needs `pnpm install`, which is forbidden on the fossil. Deferred to #558.
- **Edit the fossil's `node_modules` in place.** Not reproducible, invisible to review, and lost on the factory's replica re-clone.
- **Override `keyDown:` on `RNCWebViewImpl` only.** Narrower, but a category on a subclass can't cleanly call `NSView`'s implementation past `RCTView`, and the next Paper view hosted under Fabric would crash the same way.
- **Swizzle `+[RCTViewKeyboardEvent keyEventFromEvent:reactTag:]` to return nil.** That still sends a nil event to the event dispatcher, whose nil handling isn't guaranteed.
- **Hook the shared `-[RCTComponentEvent initWithName:viewTag:body:]` to return nil for a nil tag.** It would cover keyboard, focus and blur at once. But a replaced `init` IMP has to take over ARC's consumed-`self` / retained-return contract by hand, and every Paper view that does have a dispatcher would then be sent nil events. The keyboard path is the only one that crashed, so the narrow hook wins.
