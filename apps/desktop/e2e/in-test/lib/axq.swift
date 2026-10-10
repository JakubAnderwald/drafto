// axq — read and drive a running app through the macOS accessibility API.
//
//   axq <pid> dump [maxDepth]   one JSON array, one object per element:
//                               {path, depth, role, desc, help, id, title, value,
//                                x, y, w, h, enabled, focused, chars, caret,
//                                placeholder, subrole}
//   axq <pid> focus <path>      set AXFocused on the element at <path>
//   axq <pid> attrs <path>      list every attribute of the element at <path>
//   axq <pid> press <path>      AXPress the element (Drafto's RN views reject it
//                               with -25206; kept for other apps)
//   axq <pid> wid               CGWindowID of the app's largest on-screen window,
//                               for `screencapture -l` (captures it even when covered)
//   axq <pid> keywin            is there a key (focused) window?
//   axq <pid> makekey           activate the app and make window 0 main + key
//
// Paths are "w<window>/<child>/<child>…", so they are only stable while the UI
// does not change between a dump and a press.
import AppKit
import ApplicationServices
import Foundation

func fail(_ msg: String, _ code: Int32 = 2) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String {
  (attr(el, name) as? String) ?? ""
}

func geometry(_ el: AXUIElement) -> (CGPoint, CGSize)? {
  guard let pv = attr(el, kAXPositionAttribute as String),
    let sv = attr(el, kAXSizeAttribute as String)
  else { return nil }
  var p = CGPoint.zero
  var s = CGSize.zero
  guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s)
  else { return nil }
  return (p, s)
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[1]) else {
  fail("usage: axq <pid> dump [maxDepth] | focus|attrs|press <path> | wid | keywin | makekey")
}

// keywin: is there a key (focused) window, per the app's AXFocusedWindow?
// makekey: activate the app (all windows) and mark window 0 main + focused.
if args[2] == "keywin" || args[2] == "makekey" {
  let appEl = AXUIElementCreateApplication(pid)
  if args[2] == "makekey" {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let wins = attr(appEl, kAXWindowsAttribute as String) as? [AXUIElement], let w = wins.first {
      AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    usleep(300_000)
  }
  let focused = attr(appEl, kAXFocusedWindowAttribute as String) != nil
  let main = attr(appEl, kAXMainWindowAttribute as String) != nil
  print("focusedWindow=\(focused) mainWindow=\(main)")
  exit(0)
}

if args[2] == "wid" {
  let infos =
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]) ?? []
  var best: (id: Int, area: Double)?
  for info in infos {
    guard (info[kCGWindowOwnerPID as String] as? Int) == Int(pid),
      (info[kCGWindowLayer as String] as? Int) == 0,
      let id = info[kCGWindowNumber as String] as? Int,
      let b = info[kCGWindowBounds as String] as? [String: Double]
    else { continue }
    let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
    if best == nil || area > best!.area { best = (id, area) }
  }
  guard let found = best else { fail("axq: no on-screen window for pid \(pid)", 4) }
  print(found.id)
  exit(0)
}

guard AXIsProcessTrusted() else { fail("axq: this process is not trusted for Accessibility", 3) }

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 3.0)
let windows = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []

func resolve(_ path: String) -> AXUIElement? {
  var parts = path.split(separator: "/").map(String.init)
  guard let first = parts.first, first.hasPrefix("w"), let wi = Int(first.dropFirst()), wi < windows.count
  else { return nil }
  parts.removeFirst()
  var el = windows[wi]
  for p in parts {
    guard let i = Int(p) else { return nil }
    let kids = children(el)
    guard i < kids.count else { return nil }
    el = kids[i]
  }
  return el
}

switch args[2] {
case "dump":
  let maxDepth = args.count >= 4 ? (Int(args[3]) ?? 40) : 40
  var out: [[String: Any]] = []
  func walk(_ el: AXUIElement, _ depth: Int, _ path: String) {
    var item: [String: Any] = [
      "path": path, "depth": depth,
      "role": str(el, kAXRoleAttribute as String),
      "desc": str(el, kAXDescriptionAttribute as String),
      "help": str(el, kAXHelpAttribute as String),
      "id": str(el, "AXIdentifier"),
      "title": str(el, kAXTitleAttribute as String),
    ]
    if let v = attr(el, kAXValueAttribute as String) {
      if let s = v as? String {
        item["value"] = String(s.prefix(500))
      } else if let n = v as? NSNumber {
        item["value"] = n.stringValue
      }
    }
    if let (p, s) = geometry(el) {
      item["x"] = Double(p.x)
      item["y"] = Double(p.y)
      item["w"] = Double(s.width)
      item["h"] = Double(s.height)
    }
    if let e = attr(el, kAXEnabledAttribute as String) as? Bool { item["enabled"] = e }
    if let f = attr(el, kAXFocusedAttribute as String) as? Bool { item["focused"] = f }
    if let n = attr(el, kAXNumberOfCharactersAttribute as String) as? NSNumber { item["chars"] = n.intValue }
    if let rv = attr(el, kAXSelectedTextRangeAttribute as String) {
      var r = CFRange()
      if AXValueGetValue(rv as! AXValue, .cfRange, &r) { item["caret"] = r.location + r.length }
    }
    let placeholder = str(el, kAXPlaceholderValueAttribute as String)
    if !placeholder.isEmpty { item["placeholder"] = placeholder }
    let subrole = str(el, kAXSubroleAttribute as String)
    if !subrole.isEmpty { item["subrole"] = subrole }
    out.append(item)
    if depth >= maxDepth { return }
    for (i, k) in children(el).enumerated() { walk(k, depth + 1, "\(path)/\(i)") }
  }
  for (wi, w) in windows.enumerated() { walk(w, 0, "w\(wi)") }
  let data = try! JSONSerialization.data(withJSONObject: out, options: [])
  FileHandle.standardOutput.write(data)
  print("")
case "attrs":
  guard args.count >= 4, let el = resolve(args[3]) else { fail("axq: no element at that path", 4) }
  var names: CFArray?
  AXUIElementCopyAttributeNames(el, &names)
  for n in (names as? [String]) ?? [] {
    let v = attr(el, n)
    let shown: String
    if let s = v as? String { shown = "\"\(s.prefix(80))\"" } else if let num = v as? NSNumber { shown = num.stringValue } else { shown = v == nil ? "nil" : "<\(type(of: v!))>" }
    print("\(n) = \(shown)")
  }
case "focus":
  guard args.count >= 4, let el = resolve(args[3]) else { fail("axq: no element at that path", 4) }
  let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  if err != .success { fail("axq: setting AXFocused failed (\(err.rawValue))", 5) }
case "press":
  guard args.count >= 4, let el = resolve(args[3]) else { fail("axq: no element at that path", 4) }
  let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
  if err != .success { fail("axq: AXPress failed (\(err.rawValue))", 5) }
default:
  fail("axq: unknown command \(args[2])")
}
