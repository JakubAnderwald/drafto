#import "DraftoMenuManager.h"
#import <Cocoa/Cocoa.h>

@implementation DraftoMenuManager {
  BOOL _hasListeners;
  NSMenuItem *_themeLightItem;
  NSMenuItem *_themeDarkItem;
  NSMenuItem *_themeSystemItem;
}

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"onMenuAction"];
}

- (void)startObserving {
  _hasListeners = YES;
}

- (void)stopObserving {
  _hasListeners = NO;
}

#pragma mark - Menu Action Handler

- (void)handleMenuAction:(NSMenuItem *)sender {
  NSString *action = sender.representedObject;
  if (action && _hasListeners) {
    [self sendEventWithName:@"onMenuAction" body:@{@"action": action}];
  }
}

#pragma mark - Menu Construction Helpers

- (NSMenuItem *)menuItemWithTitle:(NSString *)title
                           action:(NSString *)actionName
                    keyEquivalent:(NSString *)key
                    modifierMask:(NSEventModifierFlags)mask {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title
                                                action:@selector(handleMenuAction:)
                                         keyEquivalent:key];
  item.target = self;
  item.representedObject = actionName;
  item.keyEquivalentModifierMask = mask;
  return item;
}

- (NSMenuItem *)standardItemWithTitle:(NSString *)title
                               action:(SEL)action
                        keyEquivalent:(NSString *)key {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title
                                                action:action
                                         keyEquivalent:key];
  // nil target = first responder chain (standard AppKit pattern)
  item.target = nil;
  return item;
}

#pragma mark - Build Menus

- (NSMenu *)buildAppMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Drafto"];

  NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:@"About Drafto"
                                                 action:@selector(orderFrontStandardAboutPanel:)
                                          keyEquivalent:@""];
  about.target = nil;
  [menu addItem:about];
  [menu addItem:[NSMenuItem separatorItem]];

  // Preferences placeholder
  NSMenuItem *prefs = [self menuItemWithTitle:@"Settings..."
                                       action:@"openSettings"
                                keyEquivalent:@","
                                modifierMask:NSEventModifierFlagCommand];
  [menu addItem:prefs];
  [menu addItem:[NSMenuItem separatorItem]];

  NSMenuItem *services = [[NSMenuItem alloc] initWithTitle:@"Services"
                                                    action:nil
                                             keyEquivalent:@""];
  NSMenu *servicesMenu = [[NSMenu alloc] initWithTitle:@"Services"];
  services.submenu = servicesMenu;
  [NSApp setServicesMenu:servicesMenu];
  [menu addItem:services];
  [menu addItem:[NSMenuItem separatorItem]];

  NSMenuItem *hide = [self standardItemWithTitle:@"Hide Drafto"
                                          action:@selector(hide:)
                                   keyEquivalent:@"h"];
  [menu addItem:hide];

  NSMenuItem *hideOthers = [self standardItemWithTitle:@"Hide Others"
                                                action:@selector(hideOtherApplications:)
                                         keyEquivalent:@"h"];
  hideOthers.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagOption;
  [menu addItem:hideOthers];

  NSMenuItem *showAll = [self standardItemWithTitle:@"Show All"
                                             action:@selector(unhideAllApplications:)
                                      keyEquivalent:@""];
  [menu addItem:showAll];
  [menu addItem:[NSMenuItem separatorItem]];

  NSMenuItem *quit = [self standardItemWithTitle:@"Quit Drafto"
                                          action:@selector(terminate:)
                                   keyEquivalent:@"q"];
  [menu addItem:quit];

  return menu;
}

- (NSMenu *)buildFileMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"File"];

  [menu addItem:[self menuItemWithTitle:@"New Note"
                                 action:@"newNote"
                          keyEquivalent:@"n"
                          modifierMask:NSEventModifierFlagCommand]];

  [menu addItem:[self menuItemWithTitle:@"New Notebook"
                                 action:@"newNotebook"
                          keyEquivalent:@"n"
                          modifierMask:NSEventModifierFlagCommand | NSEventModifierFlagShift]];

  [menu addItem:[NSMenuItem separatorItem]];

  [menu addItem:[self standardItemWithTitle:@"Close Window"
                                     action:@selector(performClose:)
                              keyEquivalent:@"w"]];

  return menu;
}

- (NSMenu *)buildEditMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Edit"];

  [menu addItem:[self standardItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"]];

  NSMenuItem *redo = [self standardItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z"];
  redo.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
  [menu addItem:redo];

  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItem:[self standardItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"]];
  [menu addItem:[self standardItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"]];
  [menu addItem:[self standardItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"]];
  [menu addItem:[self standardItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"]];

  return menu;
}

- (NSMenu *)buildViewMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"View"];

  [menu addItem:[self menuItemWithTitle:@"Toggle Sidebar"
                                 action:@"toggleSidebar"
                          keyEquivalent:@"s"
                          modifierMask:NSEventModifierFlagCommand | NSEventModifierFlagShift]];

  [menu addItem:[NSMenuItem separatorItem]];

  [menu addItem:[self menuItemWithTitle:@"Search"
                                 action:@"openSearch"
                          keyEquivalent:@"k"
                          modifierMask:NSEventModifierFlagCommand]];

  [menu addItem:[self menuItemWithTitle:@"Trash"
                                 action:@"showTrash"
                          keyEquivalent:@"t"
                          modifierMask:NSEventModifierFlagCommand | NSEventModifierFlagShift]];

  [menu addItem:[NSMenuItem separatorItem]];

  // Appearance submenu
  NSMenuItem *appearanceItem = [[NSMenuItem alloc] initWithTitle:@"Appearance"
                                                          action:nil
                                                   keyEquivalent:@""];
  NSMenu *appearanceMenu = [[NSMenu alloc] initWithTitle:@"Appearance"];

  _themeLightItem = [self menuItemWithTitle:@"Light"
                                     action:@"themeLight"
                              keyEquivalent:@""
                              modifierMask:0];
  _themeDarkItem = [self menuItemWithTitle:@"Dark"
                                    action:@"themeDark"
                             keyEquivalent:@""
                             modifierMask:0];
  _themeSystemItem = [self menuItemWithTitle:@"System"
                                      action:@"themeSystem"
                               keyEquivalent:@""
                               modifierMask:0];
  _themeSystemItem.state = NSControlStateValueOn;

  [appearanceMenu addItem:_themeLightItem];
  [appearanceMenu addItem:_themeDarkItem];
  [appearanceMenu addItem:_themeSystemItem];

  appearanceItem.submenu = appearanceMenu;
  [menu addItem:appearanceItem];

  return menu;
}

- (NSMenu *)buildWindowMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Window"];

  [menu addItem:[self standardItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"]];
  [menu addItem:[self standardItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""]];
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItem:[self standardItemWithTitle:@"Bring All to Front" action:@selector(arrangeInFront:) keyEquivalent:@""]];

  [NSApp setWindowsMenu:menu];
  return menu;
}

- (NSMenu *)buildHelpMenu {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Help"];

  NSMenuItem *help = [self menuItemWithTitle:@"Drafto Help"
                                      action:@"openHelp"
                               keyEquivalent:@""
                               modifierMask:0];
  [menu addItem:help];

  [NSApp setHelpMenu:menu];
  return menu;
}

#pragma mark - Exported Methods

RCT_EXPORT_METHOD(setupMenus) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"Main Menu"];

    // App menu
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] initWithTitle:@"Drafto" action:nil keyEquivalent:@""];
    appMenuItem.submenu = [self buildAppMenu];
    [mainMenu addItem:appMenuItem];

    // File menu
    NSMenuItem *fileMenuItem = [[NSMenuItem alloc] initWithTitle:@"File" action:nil keyEquivalent:@""];
    fileMenuItem.submenu = [self buildFileMenu];
    [mainMenu addItem:fileMenuItem];

    // Edit menu
    NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@"Edit" action:nil keyEquivalent:@""];
    editMenuItem.submenu = [self buildEditMenu];
    [mainMenu addItem:editMenuItem];

    // View menu
    NSMenuItem *viewMenuItem = [[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""];
    viewMenuItem.submenu = [self buildViewMenu];
    [mainMenu addItem:viewMenuItem];

    // Window menu
    NSMenuItem *windowMenuItem = [[NSMenuItem alloc] initWithTitle:@"Window" action:nil keyEquivalent:@""];
    windowMenuItem.submenu = [self buildWindowMenu];
    [mainMenu addItem:windowMenuItem];

    // Help menu
    NSMenuItem *helpMenuItem = [[NSMenuItem alloc] initWithTitle:@"Help" action:nil keyEquivalent:@""];
    helpMenuItem.submenu = [self buildHelpMenu];
    [mainMenu addItem:helpMenuItem];

    [NSApp setMainMenu:mainMenu];
  });
}

RCT_EXPORT_METHOD(updateMenuState:(NSDictionary *)state) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *currentTheme = state[@"currentTheme"];
    if (currentTheme) {
      self->_themeLightItem.state = [currentTheme isEqualToString:@"light"] ? NSControlStateValueOn : NSControlStateValueOff;
      self->_themeDarkItem.state = [currentTheme isEqualToString:@"dark"] ? NSControlStateValueOn : NSControlStateValueOff;
      self->_themeSystemItem.state = [currentTheme isEqualToString:@"system"] ? NSControlStateValueOn : NSControlStateValueOff;
    }
  });
}

@end
