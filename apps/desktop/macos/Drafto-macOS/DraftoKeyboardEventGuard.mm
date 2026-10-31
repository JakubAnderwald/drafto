#import <objc/runtime.h>

#import <React/RCTView.h>
#import <React/UIView+React.h>

// Stops a key press in the note editor from crashing the app.
//
// Paper -[RCTView handleKeyboardEvent:] builds an RCTComponentEvent from self.reactTag, and
// RCTComponentEvent puts that tag in an @[] literal, so a view without a tag raises
// NSInvalidArgumentException and aborts. Under Fabric, react-native-webview's RNCWebViewImpl is a
// Paper RCTView created with a plain -init, so it never gets a tag. Any key the editor page leaves
// unhandled (Escape, an unbound shortcut) goes from WKWebView to super and crashed Drafto 0.4.4 (70).
//
// A view without a tag has no JS listener and no keyDownEvents, so it steps aside: returning NO
// makes RCTView call super, and the event bubbles on to the Fabric component view that emits it.
//
// TODO(#558): this is a runtime patch only because the fossil build can't take a pnpm patch
// (ADR-0063). Once a clean install builds desktop, replace it with a pnpm patch of
// react-native-macos (0.83-stable is still unguarded), or delete it if upstream fixes it.

static BOOL (*DraftoOriginalHandleKeyboardEvent)(RCTView *, SEL, NSEvent *);

static BOOL DraftoHandleKeyboardEvent(RCTView *self, SEL _cmd, NSEvent *event)
{
  if (self.reactTag == nil) {
    return NO;
  }
  return DraftoOriginalHandleKeyboardEvent(self, _cmd, event);
}

@implementation RCTView (DraftoKeyboardEventGuard)

+ (void)load
{
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Method method = class_getInstanceMethod([RCTView class], @selector(handleKeyboardEvent:));
    if (method == NULL) {
      // A react-native-macos bump renamed the method: fail loudly in Debug so the crash this
      // guards against can't come back silently.
      NSCAssert(NO, @"[DraftoKeyboardEventGuard] -[RCTView handleKeyboardEvent:] not found");
      NSLog(@"[DraftoKeyboardEventGuard] -[RCTView handleKeyboardEvent:] not found; guard not installed");
      return;
    }
    DraftoOriginalHandleKeyboardEvent =
        (BOOL (*)(RCTView *, SEL, NSEvent *))method_setImplementation(method, (IMP)DraftoHandleKeyboardEvent);
  });
}

@end
