// Host-side layout checks for the mobile E2E runs that Maestro can't make
// itself (PrimeTestLab report 10668).
//
// Why this exists: Maestro's `below:` / `above:` selectors compare only the top
// edge of two elements, and `tapOn` succeeds on any element whose centre is
// on screen, so neither can tell whether one element covers another. The
// layout bugs in that report (the "+" button under the 3-button nav bar, the
// offline banner over the Back arrow, the light nav bar in Dark, a broken
// image offline) all pass a Maestro assertion before the fix. These checks
// read what the device itself reports instead:
//
//   - `maestro hierarchy` JSON: every element's bounds, by testID
//     (`resource-id`), text or accessibility label.
//   - `adb shell dumpsys window`: the navigationBars inset frame, and the
//     focused Drafto window's `apr=` (system-bar appearance) flags.
//   - a screenshot PNG (`adb exec-out screencap -p`, `xcrun simctl io …
//     screenshot`): the nav bar's luminance, decoded here with node:zlib.
//
// Everything above the CLI is a pure function, unit-tested with recorded
// fixtures in scripts/__tests__/maestro-layout-checks.test.mjs. The CLI is
// what apps/mobile/e2e/run-qa-10668-e2e.sh calls once a flow has left the app
// on the screen to check. Each check prints one JSON line,
// `{check, pass, reason, details}`, and exits 0 (pass), 1 (fail) or 2 (bad
// input, or nothing to measure). A check whose element or precondition is
// missing (no FAB on screen, no nav bar frame, Drafto not focused) returns
// `measured: false` and exits 2, never 1: only a measured element may fail,
// so a `--before` run can't count a wrong screen as a reproduced bug.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

// ---------------------------------------------------------------------------
// maestro hierarchy
// ---------------------------------------------------------------------------

/**
 * The tree `maestro hierarchy` prints. The CLI can print a status line or a
 * warning before the JSON, so parse from the first `{` to the last `}`.
 */
export function parseHierarchy(text) {
  const raw = String(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON object in the hierarchy dump");
  const root = JSON.parse(raw.slice(start, end + 1));
  if (typeof root !== "object" || root === null) throw new Error("hierarchy is not an object");
  return root;
}

/** `[x1,y1][x2,y2]`, Maestro's bounds format on both platforms, as a rect. */
export function parseBounds(value) {
  const m = /^\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]$/.exec(
    String(value ?? "").trim(),
  );
  if (!m) return null;
  return rect(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
}

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Every node of the tree in document order, with its attributes, its bounds
 * (null when it has none) and the index of its parent (-1 for the root).
 */
export function flattenHierarchy(root) {
  const out = [];
  const walk = (node, parent, depth) => {
    if (!node || typeof node !== "object") return;
    const attributes =
      node.attributes && typeof node.attributes === "object" ? node.attributes : {};
    const index = out.length;
    out.push({ attributes, bounds: parseBounds(attributes.bounds), parent, depth });
    for (const child of Array.isArray(node.children) ? node.children : []) {
      walk(child, index, depth + 1);
    }
  };
  walk(root, -1, 0);
  return out;
}

function matches(value, pattern) {
  if (value === undefined || value === null || value === "") return false;
  if (!(pattern instanceof RegExp)) return String(value) === pattern;
  // A /g or /y RegExp's test() starts at lastIndex and moves it: test each
  // value from 0, and leave the caller's lastIndex as it was.
  const { lastIndex } = pattern;
  pattern.lastIndex = 0;
  const found = pattern.test(String(value));
  pattern.lastIndex = lastIndex;
  return found;
}

/**
 * The nodes a selector picks, ignoring nodes with no area (Maestro lists
 * collapsed and off-tree views too).
 *
 * - `id`: the testID — `resource-id` on both platforms.
 * - `text`: the visible text, the hint, or the accessibility label, as
 *   Maestro's own text selector reads them (`text`, `hintText`,
 *   `accessibilityText`, and iOS `title` / `value`).
 * - `accessibility`: the accessibility label only (`accessibilityText`).
 *
 * Each is a string (exact match) or a RegExp. A selector with several keys
 * picks a node that matches any of them.
 */
export function findNodes(nodes, selector) {
  const textKeys = ["text", "hintText", "accessibilityText", "title", "value"];
  return nodes.filter((node) => {
    if (!node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) return false;
    const a = node.attributes;
    if (selector.id !== undefined && matches(a["resource-id"], selector.id)) return true;
    if (
      selector.accessibility !== undefined &&
      matches(a.accessibilityText, selector.accessibility)
    )
      return true;
    if (selector.text !== undefined && textKeys.some((key) => matches(a[key], selector.text)))
      return true;
    return false;
  });
}

/** The screen's size: the biggest node anchored at the origin, else the extent of all nodes. */
export function screenRect(nodes) {
  let best = null;
  let right = 0;
  let bottom = 0;
  for (const { bounds } of nodes) {
    if (!bounds) continue;
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
    if (bounds.left === 0 && bounds.top === 0) {
      if (!best || bounds.width * bounds.height > best.width * best.height) best = bounds;
    }
  }
  return best ?? rect(0, 0, right, bottom);
}

/** How many pixels two rects share vertically (0 or less when they don't). */
export function verticalOverlap(a, b) {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
}

// ---------------------------------------------------------------------------
// adb shell dumpsys window
// ---------------------------------------------------------------------------

/**
 * `dumpsys window` without its "WINDOW MANAGER LAST ANR" section. That section
 * comes first and is a snapshot of the window manager at the device's last
 * ANR, kept until it reboots, with its own "WINDOW MANAGER DISPLAY CONTENTS"
 * (windows, mCurrentFocus) inside. Read as live, it hands the checks another
 * app run's window and nav bar. The live dump starts at "WINDOW MANAGER POLICY
 * STATE", which follows it. Text without the section is returned as is.
 */
export function liveDumpsys(dumpsys) {
  const text = String(dumpsys);
  const start = text.search(/^WINDOW MANAGER LAST ANR\b/m);
  if (start === -1) return text;
  const rest = text.slice(start);
  const end = rest.search(/^WINDOW MANAGER POLICY STATE\b/m);
  return text.slice(0, start) + (end === -1 ? "" : rest.slice(end));
}

/**
 * The navigationBars inset frame from `dumpsys window`, e.g.
 * `InsetsSource id=… type=navigationBars frame=[0,2274][1080,2400] visible=true`.
 * The dump lists the source more than once (per display and per window);
 * prefer a visible one with an area. Null when there is none. A hidden frame
 * (`visible=false`) is returned only when no visible one is listed, with
 * `visible: false`: the checks don't measure against it.
 */
export function parseNavigationBarFrame(dumpsys) {
  const re =
    /type=navigationBars\s+frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\](?:\s+visible=(true|false))?/g;
  const frames = [];
  for (const m of liveDumpsys(dumpsys).matchAll(re)) {
    const frame = rect(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
    if (frame.width > 0 && frame.height > 0) frames.push({ ...frame, visible: m[5] !== "false" });
  }
  return frames.find((frame) => frame.visible) ?? frames[0] ?? null;
}

/** `wm density` output (`Physical density: 420`, maybe `Override density: 560`). */
export function parseDensity(text) {
  const override = /Override density:\s*(\d+)/.exec(String(text));
  const physical = /Physical density:\s*(\d+)/.exec(String(text));
  const m = override ?? physical;
  return m ? Number(m[1]) : null;
}

/**
 * Which navigation mode a bottom nav bar's height implies: 3-button bars are
 * 48dp, gesture handles 24dp (16dp on some builds). Null density → unknown.
 */
export function navigationMode(frame, densityDpi) {
  if (!frame || !densityDpi) return "unknown";
  const dp = frame.height / (densityDpi / 160);
  if (dp >= 40) return "three-button";
  if (dp <= 32) return "gesture";
  return "unknown";
}

/**
 * The `apr=` (system-bar appearance) flags of the focused window, when it
 * belongs to <pkg>. `dumpsys window` prints each window as
 * `Window #N Window{<hash> u0 <name>}:` followed by its attributes, and the
 * focus as `mCurrentFocus=Window{<hash> u0 <name>}`. A window whose
 * appearance is 0 prints no `apr=` at all, so its flags are [].
 *
 * Returns {window, focused, flags}, or null when no window of <pkg> is
 * listed. `focused` is false when another window (the launcher, a system
 * dialog) has the focus, in which case the first window of <pkg> is used.
 */
export function parseWindowAppearance(dumpsys, pkg = "eu.drafto.mobile") {
  const text = liveDumpsys(dumpsys);
  const headerRe = /^([ \t]*)Window #\d+ Window\{([0-9a-f]+) u\d+ ([^}\s]+)\}:[ \t]*$/gm;
  const blocks = [...text.matchAll(headerRe)].map((m) => ({
    hash: m[2],
    name: m[3],
    body: windowBody(text.slice(m.index + m[0].length), m[1].length),
  }));
  const focus = /mCurrentFocus=Window\{([0-9a-f]+) u\d+ ([^}\s]+)\}/.exec(text);
  const ofPkg = (block) => block.name === pkg || block.name.startsWith(`${pkg}/`);

  let block = focus ? blocks.find((b) => b.hash === focus[1] && ofPkg(b)) : undefined;
  const focused = Boolean(block);
  block ??= blocks.find(ofPkg);
  if (!block) return null;

  const apr = /\bapr=([A-Z_]+(?:[ \t]+[A-Z_]+)*)/.exec(block.body);
  const flags = apr ? apr[1].split(/[ \t]+/).filter(Boolean) : [];
  return { window: block.name, focused, flags };
}

/**
 * A window's lines: those after its header indented deeper than the header.
 * The next window, or the next section, ends it.
 */
function windowBody(rest, headerIndent) {
  const lines = [];
  for (const line of rest.split("\n").slice(1)) {
    if (line.trim() && line.length - line.trimStart().length <= headerIndent) break;
    lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// PNG pixels
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes a non-interlaced PNG (greyscale, RGB, palette, grey+alpha or RGBA;
 * 8 or 16 bits per sample — what screencap and simctl write) into
 * {width, height, pixel(x, y) → {r, g, b, a}}, 8 bits per channel.
 */
export function decodePng(buffer) {
  const buf = Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  let palette = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!header) throw new Error("PNG has no IHDR");
  const { width, height, bitDepth, colorType, interlace } = header;
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (colorType === 3 && (bitDepth !== 8 || !palette)) throw new Error("unsupported palette PNG");
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");

  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const a = x >= bpp ? pixels[dst + x - bpp] : 0;
      const b = y > 0 ? pixels[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[dst - stride + x - bpp] : 0;
      let out;
      if (filter === 0) out = value;
      else if (filter === 1) out = value + a;
      else if (filter === 2) out = value + b;
      else if (filter === 3) out = value + ((a + b) >> 1);
      else if (filter === 4) out = value + paeth(a, b, c);
      else throw new Error(`bad PNG filter ${filter} on row ${y}`);
      pixels[dst + x] = out & 0xff;
    }
  }

  const sample = (i) => pixels[i]; // the high byte of a 16-bit sample comes first
  const pixel = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height)
      throw new Error(`pixel ${x},${y} is off the image`);
    const i = y * stride + x * bpp;
    const s = (n) => sample(i + n * bytesPerSample);
    switch (colorType) {
      case 0:
        return { r: s(0), g: s(0), b: s(0), a: 255 };
      case 2:
        return { r: s(0), g: s(1), b: s(2), a: 255 };
      case 3: {
        const p = s(0) * 3;
        return { r: palette[p], g: palette[p + 1], b: palette[p + 2], a: 255 };
      }
      case 4:
        return { r: s(0), g: s(0), b: s(0), a: s(1) };
      default:
        return { r: s(0), g: s(1), b: s(2), a: s(3) };
    }
  };
  return { width, height, pixel };
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * The median luminance of a grid of pixels inside <region> (image pixels).
 * The median ignores a few odd pixels (an icon edge, a cursor).
 */
export function sampleLuminance(png, region, { cols = 8, rows = 3 } = {}) {
  const values = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.round(region.left + ((col + 0.5) / cols) * (region.right - region.left));
      const y = Math.round(region.top + ((row + 0.5) / rows) * (region.bottom - region.top));
      const cx = Math.min(png.width - 1, Math.max(0, x));
      const cy = Math.min(png.height - 1, Math.max(0, y));
      values.push(relativeLuminance(png.pixel(cx, cy)));
    }
  }
  values.sort((p, q) => p - q);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Where to sample a bottom nav bar, in image pixels: its left tenth, between
 * 2% and 12% of the width and across the middle of its height. That is the
 * scrim, clear of the 3-button icons (at about 25%, 50% and 75%) and of the
 * gesture handle (centred). <screenWidth> is the width the frame is measured
 * in; the screenshot may be scaled from it.
 */
export function navBarSampleRegion(frame, png, screenWidth = frame.right) {
  if (!Number.isFinite(screenWidth) || screenWidth <= 0) {
    throw new Error(`screen width must be a positive number, not ${screenWidth}`);
  }
  const scale = png.width / screenWidth;
  return {
    left: (frame.left + frame.width * 0.02) * scale,
    right: (frame.left + frame.width * 0.12) * scale,
    top: (frame.top + frame.height * 0.35) * scale,
    bottom: (frame.top + frame.height * 0.65) * scale,
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

function verdict(check, pass, reason, details) {
  return { check, pass, reason, details };
}

/**
 * The element a check must measure is absent, or a precondition for
 * measuring it fails. Not a fail: the CLI exits 2 for it.
 */
function unmeasured(check, reason, details) {
  return { check, pass: false, measured: false, reason, details };
}

function boundsOf(nodes) {
  return nodes.map((node) => node.bounds);
}

/**
 * M-01 (Android): every `add` FAB on screen sits wholly above the nav bar's
 * top edge. Fails by about 74px at 420dpi in 3-button mode before the fix
 * (the FAB's bottom margin is 20dp; the bar is 48dp).
 */
export function fabAboveNavBar(hierarchy, dumpsys, { fabId = "add", tolerance = 0 } = {}) {
  const check = "fab-above-nav-bar";
  const nodes = flattenHierarchy(hierarchy);
  const fabs = findNodes(nodes, { id: fabId });
  const navBar = parseNavigationBarFrame(dumpsys);
  if (fabs.length === 0) return unmeasured(check, `no element with id "${fabId}" on screen`, {});
  if (!navBar)
    return unmeasured(check, "dumpsys has no navigationBars frame", { fab: boundsOf(fabs) });
  if (!navBar.visible) {
    return unmeasured(check, "the nav bar is hidden (visible=false)", {
      fab: boundsOf(fabs),
      navBar,
    });
  }
  if (navBar.width < navBar.height) {
    return unmeasured(check, "the nav bar is at the side; run the check in portrait", {
      navBar,
    });
  }
  const worst = Math.max(...fabs.map((fab) => fab.bounds.bottom - navBar.top));
  const pass = worst <= tolerance;
  return verdict(
    check,
    pass,
    pass
      ? `FAB bottom is ${-worst}px above the nav bar`
      : `FAB bottom is ${worst}px below the nav bar's top edge (${navBar.top})`,
    { fab: boundsOf(fabs), navBar, overlapPx: Math.max(0, worst) },
  );
}

/**
 * M-01 (iOS): every `add` FAB sits wholly above the home indicator's safe
 * area — the bottom <safeBottom> points (34 on Face ID iPhones). Maestro's
 * iOS bounds are in points.
 */
export function fabAboveHomeIndicator(
  hierarchy,
  { fabId = "add", safeBottom = 34, screenHeight, tolerance = 0 } = {},
) {
  const check = "fab-above-home-indicator";
  const nodes = flattenHierarchy(hierarchy);
  const fabs = findNodes(nodes, { id: fabId });
  if (fabs.length === 0) return unmeasured(check, `no element with id "${fabId}" on screen`, {});
  const height = screenHeight ?? screenRect(nodes).bottom;
  const limit = height - safeBottom;
  const worst = Math.max(...fabs.map((fab) => fab.bounds.bottom - limit));
  const pass = worst <= tolerance;
  return verdict(
    check,
    pass,
    pass
      ? `FAB bottom is ${-worst}pt above the home-indicator area`
      : `FAB bottom reaches ${worst}pt into the home-indicator area (screen ${height}pt, inset ${safeBottom}pt)`,
    { fab: boundsOf(fabs), screenHeight: height, safeBottom, overlapPt: Math.max(0, worst) },
  );
}

/** Whether a node belongs to Android's System UI (the status or navigation bar). */
function isSystemUi(node) {
  return String(node.attributes["resource-id"] ?? "").startsWith("com.android.systemui:");
}

/** The header a back button sits in: its smallest ancestor spanning the screen's width. */
function headerOf(nodes, index, screen) {
  let parent = nodes[index].parent;
  while (parent !== -1) {
    const { bounds } = nodes[parent];
    if (bounds && bounds.width >= screen.width * 0.9 && bounds.height <= screen.height * 0.3) {
      return bounds;
    }
    parent = nodes[parent].parent;
  }
  return nodes[index].bounds;
}

export const DEFAULT_BACK_SELECTOR = {
  // Android: react-native-screens' AppCompat up button. iOS: UIKit's back button.
  accessibility: /^(Navigate up|Back)$/,
  id: "BackButton",
};

/**
 * M-03: the offline banner neither covers the header's back button nor sits
 * above the header. The banner is found by its testID (`offline-banner`,
 * added by the M-03 fix) or, on a build without it, by its text.
 *
 * Passing needs, for every banner and back button on screen:
 *   - no vertical overlap (more than <tolerance> px), and
 *   - the banner's top at or below the header's bottom (within
 *     <tolerance>), which also catches a banner pushed above the header with
 *     a blank status-bar-high strip between them.
 * `details.gap` is banner top − header bottom: 0 when the banner hangs
 * straight off the header.
 */
export function bannerClearOfBack(
  hierarchy,
  {
    bannerId = "offline-banner",
    bannerText = /^You are offline$/,
    back = DEFAULT_BACK_SELECTOR,
    tolerance = 2,
  } = {},
) {
  const check = "banner-clear-of-back";
  const nodes = flattenHierarchy(hierarchy);
  let banners = findNodes(nodes, { id: bannerId });
  const bannerBy = banners.length ? "id" : "text";
  if (!banners.length) banners = findNodes(nodes, { text: bannerText });
  // The 3-button nav bar's own Back key (com.android.systemui:id/back,
  // labelled "Back") is in Maestro's hierarchy too. It is no header's back
  // button: paired with it, every banner would sit "above the header".
  const backs = findNodes(nodes, back).filter((node) => !isSystemUi(node));
  if (!banners.length) return unmeasured(check, "no offline banner on screen", {});
  if (!backs.length)
    return unmeasured(check, "no back button on screen", { banner: boundsOf(banners) });

  const screen = screenRect(nodes);
  const pairs = [];
  for (const banner of banners) {
    for (const backNode of backs) {
      const header = headerOf(nodes, nodes.indexOf(backNode), screen);
      pairs.push({
        banner: banner.bounds,
        back: backNode.bounds,
        header,
        overlap: verticalOverlap(banner.bounds, backNode.bounds),
        gap: banner.bounds.top - header.bottom,
      });
    }
  }
  const covering = pairs.find((pair) => pair.overlap > tolerance);
  const above = pairs.find((pair) => pair.gap < -tolerance);
  const details = { bannerBy, pairs };
  if (covering) {
    return verdict(
      check,
      false,
      `the banner covers the back button by ${covering.overlap}px`,
      details,
    );
  }
  if (above) {
    return verdict(
      check,
      false,
      `the banner sits above the header (its top is ${-above.gap}px above the header's bottom)`,
      details,
    );
  }
  const flush = pairs.every((pair) => Math.abs(pair.gap) <= tolerance);
  return verdict(
    check,
    true,
    flush ? "the banner hangs straight off the header" : "the banner is below the header",
    { ...details, flush },
  );
}

/** The editor's E2E image status views (ADR-0086), one per image in the note. */
export const IMAGE_PROBE_IDS = {
  rendered: "editor-image-rendered",
  missing: "editor-image-missing",
};
const IMAGE_PROBE_LABEL = /^Image (?:shown|not loaded): /;

/**
 * M-02: the note's images rendered. <alt> picks the images by file name.
 *
 * An E2E probe build (ADR-0086) has a status view per image, testID
 * `editor-image-rendered` or `editor-image-missing`, labelled "Image shown:
 * <name>" or "Image not loaded: <name>". When any probe for <alt> is on
 * screen, the probes alone decide: it passes when none says missing. Any
 * other node with a matching label (the WebView's <img>, a caption or a link
 * that names the file) is ignored then, so a short caption can't fail a
 * loaded image.
 *
 * Without probes, it reads the WebView's own nodes: a WebView exposes an
 * <img> to the accessibility tree under its alt text (the file name); a
 * broken image is drawn as a small icon plus that text, a loaded one at the
 * photo's size. It passes when at least one image matches and every match is
 * at least <minHeight> tall.
 */
export function imageRendered(
  hierarchy,
  { alt = /\.(jpe?g|png|gif|webp|heic)$/i, minHeight = 100 } = {},
) {
  const check = "image-rendered";
  const nodes = flattenHierarchy(hierarchy);
  const probes = findNodes(nodes, {
    id: new RegExp(`^(?:${IMAGE_PROBE_IDS.rendered}|${IMAGE_PROBE_IDS.missing})$`),
  }).filter((node) =>
    matches(String(node.attributes.accessibilityText ?? "").replace(IMAGE_PROBE_LABEL, ""), alt),
  );
  if (probes.length) {
    const missing = probes.filter(
      (node) => node.attributes["resource-id"] === IMAGE_PROBE_IDS.missing,
    );
    const details = {
      by: "probe",
      images: probes.map((node) => ({
        label: node.attributes.accessibilityText,
        bounds: node.bounds,
      })),
    };
    if (missing.length) {
      return verdict(
        check,
        false,
        `${missing.length} of ${probes.length} images did not load (${IMAGE_PROBE_IDS.missing})`,
        details,
      );
    }
    return verdict(
      check,
      true,
      `${probes.length} image(s) rendered (${IMAGE_PROBE_IDS.rendered})`,
      details,
    );
  }
  const images = findNodes(nodes, { text: alt });
  if (!images.length) return unmeasured(check, `no image matching ${alt} on screen`, {});
  const short = images.filter((node) => node.bounds.height < minHeight);
  const details = { by: "alt", images: boundsOf(images), minHeight };
  if (short.length) {
    return verdict(
      check,
      false,
      `${short.length} of ${images.length} images are under ${minHeight} tall (broken placeholder)`,
      details,
    );
  }
  return verdict(check, true, `${images.length} image(s) rendered at full size`, details);
}

export const NAV_BAR_THRESHOLDS = { darkMax: 0.25, lightMin: 0.6 };

/**
 * M-04: the nav bar matches the in-app theme. <expect> is "dark" or "light".
 * Two signals, both required:
 *   - the pixels: the scrim's median luminance is under 0.25 (dark) or over
 *     0.6 (light);
 *   - the focused Drafto window's appearance: no LIGHT_NAVIGATION_BARS flag
 *     (dark) or the flag set (light).
 *
 * The two come from different reads (<dumpsys>, then the screenshot), so a
 * bar still repainting could pair one state's flags with another's pixels.
 * Given <dumpsysAfter>, a second dump taken after the screenshot, it measures
 * only when both dumps show the same nav-bar frame and the same Drafto
 * window appearance: the screenshot was taken in that settled state.
 */
export function navBarMatches(
  expect,
  png,
  dumpsys,
  { pkg = "eu.drafto.mobile", screenWidth, thresholds = NAV_BAR_THRESHOLDS, dumpsysAfter } = {},
) {
  if (expect !== "dark" && expect !== "light")
    throw new Error(`expect must be dark or light, not ${expect}`);
  const check = `nav-bar-${expect}`;
  const navBar = parseNavigationBarFrame(dumpsys);
  if (!navBar) return unmeasured(check, "dumpsys has no navigationBars frame", {});
  if (!navBar.visible)
    return unmeasured(check, "the nav bar is hidden (visible=false)", { navBar });
  const appearance = parseWindowAppearance(dumpsys, pkg);
  if (!appearance) return unmeasured(check, `no ${pkg} window in dumpsys`, { navBar });
  if (!appearance.focused) {
    return unmeasured(check, `${pkg} is not the focused window`, { navBar, appearance });
  }
  if (dumpsysAfter !== undefined) {
    const navBarAfter = parseNavigationBarFrame(dumpsysAfter);
    const appearanceAfter = parseWindowAppearance(dumpsysAfter, pkg);
    if (
      JSON.stringify(navBarAfter) !== JSON.stringify(navBar) ||
      JSON.stringify(appearanceAfter) !== JSON.stringify(appearance)
    ) {
      return unmeasured(
        check,
        "the nav bar or the Drafto window's appearance changed while the screenshot was taken",
        { navBar, navBarAfter, appearance, appearanceAfter },
      );
    }
  }
  const region = navBarSampleRegion(navBar, png, screenWidth ?? navBar.right);
  const luminance = sampleLuminance(png, region);
  const lightFlag = appearance.flags.includes("LIGHT_NAVIGATION_BARS");
  const pixelsOk =
    expect === "dark" ? luminance < thresholds.darkMax : luminance > thresholds.lightMin;
  const flagOk = expect === "dark" ? !lightFlag : lightFlag;
  const details = { navBar, region, luminance: Number(luminance.toFixed(4)), appearance };
  const problems = [];
  if (!pixelsOk) {
    problems.push(
      expect === "dark"
        ? `nav bar luminance ${luminance.toFixed(3)} is not under ${thresholds.darkMax}`
        : `nav bar luminance ${luminance.toFixed(3)} is not over ${thresholds.lightMin}`,
    );
  }
  if (!flagOk) {
    problems.push(
      expect === "dark"
        ? "the window still asks for light nav-bar buttons (apr=LIGHT_NAVIGATION_BARS)"
        : "the window doesn't ask for light nav-bar buttons (no apr=LIGHT_NAVIGATION_BARS)",
    );
  }
  return verdict(
    check,
    problems.length === 0,
    problems.length
      ? problems.join("; ")
      : `nav bar is ${expect} (luminance ${luminance.toFixed(3)})`,
    details,
  );
}

/**
 * Evidence for the run log: the nav bar's frame and the mode its height
 * implies. A mode it can't tell (no frame, no density, an odd height)
 * measured nothing, so it is unmeasured, not a fail.
 */
export function navModeReport(dumpsys, densityText) {
  const navBar = parseNavigationBarFrame(dumpsys);
  const density = parseDensity(densityText);
  const mode = navigationMode(navBar, density);
  const details = { navBar, density, mode };
  if (mode === "unknown") return unmeasured("nav-mode", "navigation mode: unknown", details);
  return verdict("nav-mode", true, `navigation mode: ${mode}`, details);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `Usage: node scripts/lib/maestro-layout-checks.mjs <check> [--flag value]...

Checks (each prints one JSON line; exit 0 pass, 1 fail, 2 bad input or nothing to measure):
  fab-above-nav-bar          --hierarchy <json> --dumpsys <txt> [--fab-id add] [--tolerance 0]
  fab-above-home-indicator   --hierarchy <json> [--fab-id add] [--safe-bottom 34] [--screen-height <pt>]
  banner-clear-of-back       --hierarchy <json> [--banner-id offline-banner] [--banner-text <regex>]
                             [--back-label <regex>] [--tolerance 2]
  image-rendered             --hierarchy <json> [--alt <regex>] [--min-height 100]
  nav-bar-dark | nav-bar-light --screenshot <png> --dumpsys <txt> [--dumpsys-after <txt>]
                             [--screen-width <px>]
  nav-mode                   --dumpsys <txt> --density <wm density output file>
  bounds                     --hierarchy <json> (--id <regex> | --text <regex>)

<regex> values are anchored for you: --alt 'photo\\.jpg' matches the whole label.`;

function anchored(source) {
  return new RegExp(`^(?:${source})$`);
}

function numberFlag(flags, key, fallback) {
  if (flags[key] === undefined) return fallback;
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
  return value;
}

function requireFlag(flags, key) {
  if (!flags[key]) throw new Error(`--${key} is required`);
  return flags[key];
}

/**
 * Runs one check from argv. <read> reads a file (injected for tests).
 * Returns {code, output}.
 */
export function runCli(argv, read = (file) => readFileSync(file)) {
  let flags;
  let positional;
  try {
    ({ flags, positional } = parseFlags(argv));
  } catch (error) {
    return { code: 2, output: `${error.message}\n${USAGE}` };
  }
  const [check] = positional;
  const text = (key) => read(requireFlag(flags, key)).toString("utf8");
  const hierarchy = () => parseHierarchy(text("hierarchy"));
  try {
    let result;
    switch (check) {
      case "fab-above-nav-bar":
        result = fabAboveNavBar(hierarchy(), text("dumpsys"), {
          fabId: flags["fab-id"] ?? "add",
          tolerance: numberFlag(flags, "tolerance", 0),
        });
        break;
      case "fab-above-home-indicator":
        result = fabAboveHomeIndicator(hierarchy(), {
          fabId: flags["fab-id"] ?? "add",
          safeBottom: numberFlag(flags, "safe-bottom", 34),
          screenHeight: numberFlag(flags, "screen-height", undefined),
          tolerance: numberFlag(flags, "tolerance", 0),
        });
        break;
      case "banner-clear-of-back":
        result = bannerClearOfBack(hierarchy(), {
          bannerId: flags["banner-id"] ?? "offline-banner",
          bannerText: flags["banner-text"] ? anchored(flags["banner-text"]) : /^You are offline$/,
          back: flags["back-label"]
            ? { accessibility: anchored(flags["back-label"]), id: "BackButton" }
            : DEFAULT_BACK_SELECTOR,
          tolerance: numberFlag(flags, "tolerance", 2),
        });
        break;
      case "image-rendered":
        result = imageRendered(hierarchy(), {
          alt: flags.alt ? anchored(flags.alt) : /\.(jpe?g|png|gif|webp|heic)$/i,
          minHeight: numberFlag(flags, "min-height", 100),
        });
        break;
      case "nav-bar-dark":
      case "nav-bar-light":
        result = navBarMatches(
          check === "nav-bar-dark" ? "dark" : "light",
          decodePng(read(requireFlag(flags, "screenshot"))),
          text("dumpsys"),
          {
            screenWidth: numberFlag(flags, "screen-width", undefined),
            dumpsysAfter: flags["dumpsys-after"] ? text("dumpsys-after") : undefined,
          },
        );
        break;
      case "nav-mode":
        result = navModeReport(text("dumpsys"), text("density"));
        break;
      case "bounds": {
        const selector = {};
        if (flags.id) selector.id = anchored(flags.id);
        if (flags.text) selector.text = anchored(flags.text);
        if (!flags.id && !flags.text) throw new Error("--id or --text is required");
        const found = findNodes(flattenHierarchy(hierarchy()), selector);
        result = verdict("bounds", found.length > 0, `${found.length} match(es)`, {
          matches: found.map(({ attributes, bounds }) => ({ attributes, bounds })),
        });
        break;
      }
      default:
        return { code: 2, output: `Unknown check "${check ?? ""}"\n${USAGE}` };
    }
    const code = result.measured === false ? 2 : result.pass ? 0 : 1;
    return { code, output: JSON.stringify(result) };
  } catch (error) {
    return {
      code: 2,
      output: JSON.stringify({
        check,
        pass: false,
        reason: `bad input: ${error.message}`,
        details: {},
      }),
    };
  }
}

if (isMainModule(import.meta.url)) {
  const { code, output } = runCli(process.argv.slice(2));
  (code === 2 && !output.startsWith("{") ? process.stderr : process.stdout).write(`${output}\n`);
  // Not process.exit(): on macOS a write to a pipe is asynchronous, and exit
  // would drop what hasn't been flushed yet.
  process.exitCode = code;
}
