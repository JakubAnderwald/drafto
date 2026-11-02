#import <RCTAppDelegate.h>
#import <Cocoa/Cocoa.h>

@interface AppDelegate : RCTAppDelegate

/// Brings the main window back after it was closed. Sent nil-targeted by Window → Drafto (⌘0),
/// so it reaches the app delegate through the responder chain.
- (IBAction)showMainWindow:(id)sender;

@end
