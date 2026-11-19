import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  bannerClearOfBack,
  decodePng,
  fabAboveHomeIndicator,
  fabAboveNavBar,
  findNodes,
  flattenHierarchy,
  imageRendered,
  liveDumpsys,
  navBarMatches,
  navBarSampleRegion,
  navModeReport,
  navigationMode,
  parseBounds,
  parseDensity,
  parseHierarchy,
  parseNavigationBarFrame,
  parseWindowAppearance,
  relativeLuminance,
  runCli,
  sampleLuminance,
  screenRect,
  verticalOverlap,
} from "../lib/maestro-layout-checks.mjs";

// The host-side checks behind apps/mobile/e2e/run-qa-10668-e2e.sh. Each
// fixture is shaped like what the device reports (`maestro hierarchy`,
// `adb shell dumpsys window`, a screencap PNG) on a 1080x2400 @420dpi
// emulator or a 402x874pt iPhone, before and after the PrimeTestLab 10668
// fixes. Every check must fail on the "before" fixture and pass on the
// "after" one: a check that passes on both proves nothing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "maestro-layout");
const CLI = path.join(HERE, "..", "lib", "maestro-layout-checks.mjs");

const fixturePath = (name) => path.join(FIXTURES, name);
const text = (name) => readFileSync(fixturePath(name), "utf8");
const tree = (name) => parseHierarchy(text(name));

// --- A minimal PNG encoder, so the pixel fixtures are built, not binary blobs.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * A PNG whose pixel (x, y) is color(x, y) → [samples...]. Rows cycle through
 * the given filter types, so the decoder's unfiltering is exercised.
 */
function encodePng({
  width,
  height,
  colorType = 6,
  bitDepth = 8,
  color,
  filters = [0],
  palette,
  interlace = 0,
}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bps = bitDepth / 8;
  const bpp = channels * bps;
  const stride = width * bpp;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const samples = color(x, y);
      samples.forEach((value, i) => {
        if (bps === 2) row.writeUInt16BE(value * 257, x * bpp + i * 2);
        else row[x * bpp + i] = value;
      });
    }
    const filter = filters[y % filters.length];
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      out[i + 1] = (row[i] - predictor) & 0xff;
    }
    rows.push(out);
    prev = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A screencap at 1/10 scale (108x240) of a screen whose nav bar
 * ([0,2274][1080,2400] → rows 227..239) is <bar> and the rest <body>, with
 * white 3-button icons at 25%, 50% and 75% of the width.
 */
function screencap(bar, body = [128, 128, 128]) {
  return encodePng({
    width: 108,
    height: 240,
    filters: [0, 1, 2, 3, 4],
    color: (x, y) => {
      if (y < 227) return [...body, 255];
      const icon = [27, 54, 81].some((cx) => Math.abs(x - cx) <= 3) && y >= 231 && y <= 235;
      return icon ? [255, 255, 255, 255] : [...bar, 255];
    },
  });
}

const DARK_SCRIM = [24, 24, 28];
const LIGHT_SCRIM = [242, 242, 246];

describe("parseHierarchy / parseBounds / flattenHierarchy", () => {
  it("parses the JSON even after a status line from the CLI", () => {
    const root = parseHierarchy(
      `Running on emulator-5554\n${text("android-notebook-fab-no-inset.json")}`,
    );
    assert.equal(root.attributes.bounds, "[0,0][1080,2400]");
  });

  it("rejects a dump with no JSON object", () => {
    assert.throws(() => parseHierarchy("maestro: no devices"), /no JSON object/);
    assert.throws(() => parseHierarchy("null } {"), /no JSON object|not an object/);
  });

  it("reads Maestro's [x1,y1][x2,y2] bounds, including iOS fractions", () => {
    assert.deepEqual(parseBounds("[881,2201][1028,2348]"), {
      left: 881,
      top: 2201,
      right: 1028,
      bottom: 2348,
      width: 147,
      height: 147,
    });
    assert.equal(parseBounds("[0.5,62][402,116.33]").top, 62);
    assert.equal(parseBounds("[0,0,10,10]"), null);
    assert.equal(parseBounds(undefined), null);
  });

  it("flattens in document order, with parents and depth", () => {
    const nodes = flattenHierarchy(tree("android-offline-note-banner-clear.json"));
    const back = nodes.findIndex((node) => node.attributes.accessibilityText === "Navigate up");
    const toolbar = nodes[nodes[back].parent];
    assert.equal(toolbar.attributes.class, "com.swmansion.rnscreens.CustomToolbar");
    assert.equal(nodes[0].parent, -1);
    assert.equal(nodes[back].depth, 3);
  });

  it("tolerates nodes without attributes or children", () => {
    const nodes = flattenHierarchy({ children: [{ attributes: { bounds: "[0,0][1,1]" } }, null] });
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].bounds, null);
  });
});

describe("findNodes / screenRect / verticalOverlap", () => {
  const nodes = flattenHierarchy(tree("android-offline-note-banner-clear.json"));

  it("finds by testID, text or accessibility label, exactly or by RegExp", () => {
    assert.equal(findNodes(nodes, { id: "offline-banner" }).length, 1);
    // The container's label and the Text node's text both say it.
    assert.equal(findNodes(nodes, { text: "You are offline" }).length, 2);
    assert.equal(findNodes(nodes, { accessibility: /^Navigate/ }).length, 1);
    assert.equal(findNodes(nodes, { text: "offline" }).length, 0);
  });

  it("tests a global RegExp from the start for every node, and leaves its lastIndex", () => {
    const nodes = flattenHierarchy({
      children: [
        { attributes: { "resource-id": "add", bounds: "[0,0][10,10]" } },
        { attributes: { "resource-id": "add", bounds: "[0,20][10,30]" } },
      ],
    });
    const pattern = /add/g;
    pattern.lastIndex = 1;
    assert.equal(findNodes(nodes, { id: pattern }).length, 2);
    assert.equal(pattern.lastIndex, 1);
  });

  it("skips nodes with no area", () => {
    const flat = flattenHierarchy({
      attributes: { bounds: "[0,0][10,10]" },
      children: [{ attributes: { "resource-id": "add", bounds: "[5,5][5,5]" } }],
    });
    assert.deepEqual(findNodes(flat, { id: "add" }), []);
  });

  it("takes the screen from the biggest node at the origin", () => {
    assert.deepEqual(screenRect(nodes), parseBounds("[0,0][1080,2400]"));
    const loose = flattenHierarchy({
      children: [
        { attributes: { bounds: "[10,20][300,400]" } },
        { attributes: { bounds: "[0,500][50,874]" } },
      ],
    });
    assert.equal(screenRect(loose).bottom, 874);
  });

  it("measures vertical overlap", () => {
    assert.equal(verticalOverlap(parseBounds("[0,0][1,100]"), parseBounds("[0,90][1,200]")), 10);
    assert.ok(verticalOverlap(parseBounds("[0,0][1,100]"), parseBounds("[0,100][1,200]")) <= 0);
  });
});

describe("dumpsys window parsing", () => {
  it("reads the 3-button and gesture nav-bar frames", () => {
    assert.deepEqual(parseNavigationBarFrame(text("dumpsys-window-3button-light.txt")), {
      left: 0,
      top: 2274,
      right: 1080,
      bottom: 2400,
      width: 1080,
      height: 126,
      visible: true,
    });
    assert.equal(parseNavigationBarFrame(text("dumpsys-window-gesture.txt")).height, 63);
    assert.equal(parseNavigationBarFrame("no insets here"), null);
  });

  it("prefers a visible frame with an area", () => {
    const dump = [
      "InsetsSource id=1 type=navigationBars frame=[0,0][0,0] visible=true",
      "InsetsSource id=2 type=navigationBars frame=[0,2274][1080,2400] visible=false",
      "InsetsSource id=3 type=navigationBars frame=[0,2337][1080,2400] visible=true",
    ].join("\n");
    assert.equal(parseNavigationBarFrame(dump).top, 2337);
    assert.equal(parseNavigationBarFrame(dump.split("\n")[1]).visible, false);
  });

  it("tells 3-button from gesture navigation by the bar's height in dp", () => {
    const density = parseDensity(text("wm-density-420.txt"));
    assert.equal(density, 420);
    assert.equal(parseDensity(text("wm-density-override-560.txt")), 560);
    assert.equal(parseDensity("nothing"), null);
    const threeButton = parseNavigationBarFrame(text("dumpsys-window-3button-light.txt"));
    const gesture = parseNavigationBarFrame(text("dumpsys-window-gesture.txt"));
    assert.equal(navigationMode(threeButton, density), "three-button");
    assert.equal(navigationMode(gesture, density), "gesture");
    assert.equal(navigationMode({ height: 95 }, 420), "unknown");
    assert.equal(navigationMode(null, 420), "unknown");
    assert.equal(navigationMode(threeButton, null), "unknown");
  });

  it("reads the focused Drafto window's apr= flags", () => {
    assert.deepEqual(parseWindowAppearance(text("dumpsys-window-3button-light.txt")), {
      window: "eu.drafto.mobile/eu.drafto.mobile.MainActivity",
      hash: "5f1e0b7",
      focused: true,
      flags: ["LIGHT_STATUS_BARS", "LIGHT_NAVIGATION_BARS"],
    });
    assert.deepEqual(
      parseWindowAppearance(text("dumpsys-window-3button-app-dark-light-bar.txt")).flags,
      ["LIGHT_NAVIGATION_BARS"],
    );
  });

  it("reads no apr= as no flags, without borrowing the next window's", () => {
    const dark = parseWindowAppearance(text("dumpsys-window-3button-dark.txt"));
    assert.deepEqual(dark.flags, []);
    assert.equal(dark.focused, true);
  });

  it("ignores the last ANR's snapshot at the top of the dump", () => {
    // `dumpsys window` opens with the window manager as it was at the device's
    // last ANR (kept until reboot), its own display contents and focus included.
    const live = text("dumpsys-window-3button-dark.txt");
    const dump = [
      "WINDOW MANAGER LAST ANR (dumpsys window lastanr)",
      "  ANR time: Nov 18, 2026 9:55:09 PM",
      "WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)",
      text("dumpsys-window-gesture.txt"),
      text("dumpsys-window-3button-app-dark-light-bar.txt"),
      "WINDOW MANAGER POLICY STATE (dumpsys window policy)",
      live,
    ].join("\n");
    assert.deepEqual(parseWindowAppearance(dump), parseWindowAppearance(live));
    assert.deepEqual(parseWindowAppearance(dump).flags, []);
    assert.equal(parseNavigationBarFrame(dump).height, 126);
    assert.equal(liveDumpsys(live), live);
    assert.equal(liveDumpsys(dump).includes("ANR time"), false);
  });

  it("says when another window has the focus, or Drafto has none", () => {
    const launcher = parseWindowAppearance(text("dumpsys-window-launcher-focused.txt"));
    assert.equal(launcher.focused, false);
    assert.equal(launcher.window, "eu.drafto.mobile/eu.drafto.mobile.MainActivity");
    assert.equal(
      parseWindowAppearance(text("dumpsys-window-3button-light.txt"), "com.example"),
      null,
    );
  });
});

describe("decodePng / luminance", () => {
  it("decodes RGBA with every filter type", () => {
    const png = decodePng(
      encodePng({
        width: 7,
        height: 10,
        filters: [0, 1, 2, 3, 4],
        color: (x, y) => [x * 30, y * 20, (x * y) % 256, 200],
      }),
    );
    assert.equal(png.width, 7);
    assert.equal(png.height, 10);
    for (const [x, y] of [
      [0, 0],
      [6, 9],
      [3, 4],
      [5, 7],
    ]) {
      assert.deepEqual(png.pixel(x, y), { r: x * 30, g: y * 20, b: (x * y) % 256, a: 200 });
    }
    assert.throws(() => png.pixel(7, 0), /off the image/);
  });

  it("decodes RGB, greyscale, grey+alpha, palette and 16-bit images", () => {
    const rgb = decodePng(encodePng({ width: 2, height: 2, colorType: 2, color: () => [1, 2, 3] }));
    assert.deepEqual(rgb.pixel(1, 1), { r: 1, g: 2, b: 3, a: 255 });
    const grey = decodePng(encodePng({ width: 2, height: 2, colorType: 0, color: () => [90] }));
    assert.deepEqual(grey.pixel(0, 1), { r: 90, g: 90, b: 90, a: 255 });
    const greyAlpha = decodePng(
      encodePng({ width: 2, height: 1, colorType: 4, color: () => [10, 20] }),
    );
    assert.deepEqual(greyAlpha.pixel(1, 0), { r: 10, g: 10, b: 10, a: 20 });
    const palette = decodePng(
      encodePng({
        width: 2,
        height: 1,
        colorType: 3,
        palette: [0, 0, 0, 9, 8, 7],
        color: (x) => [x],
      }),
    );
    assert.deepEqual(palette.pixel(1, 0), { r: 9, g: 8, b: 7, a: 255 });
    const deep = decodePng(
      encodePng({
        width: 3,
        height: 3,
        bitDepth: 16,
        filters: [1, 4, 2],
        color: (x) => [x * 50, 7, 255, 255],
      }),
    );
    assert.deepEqual(deep.pixel(2, 2), { r: 100, g: 7, b: 255, a: 255 });
  });

  it("rejects what it can't decode", () => {
    assert.throws(() => decodePng(Buffer.from("GIF89a")), /not a PNG/);
    assert.throws(
      () => decodePng(encodePng({ width: 1, height: 1, interlace: 1, color: () => [0, 0, 0, 0] })),
      /interlaced/,
    );
    assert.throws(
      () => decodePng(encodePng({ width: 1, height: 1, colorType: 3, color: () => [0] })),
      /palette/,
    );
    const bad = encodePng({ width: 1, height: 1, color: () => [0, 0, 0, 0] });
    bad[25] = 5; // colour type 5 doesn't exist
    assert.throws(() => decodePng(bad), /colour type 5/);
    const filter = encodePng({ width: 1, height: 1, filters: [7], color: () => [0, 0, 0, 0] });
    assert.throws(() => decodePng(filter), /bad PNG filter 7/);
  });

  it("rejects a screenshot cut off mid-write", () => {
    const whole = encodePng({ width: 4, height: 4, color: () => [1, 2, 3, 255] });
    assert.deepEqual(decodePng(whole).pixel(3, 3), { r: 1, g: 2, b: 3, a: 255 });
    // The IDAT chunk declares more data than the file holds.
    const idat = whole.indexOf("IDAT", 0, "latin1") - 4;
    assert.throws(() => decodePng(whole.subarray(0, idat + 10)), /truncated \(in its IDAT chunk\)/);
    // Every chunk is whole, but the file stops before IEND.
    assert.throws(() => decodePng(whole.subarray(0, whole.length - 12)), /no IEND/);
  });

  it("computes WCAG relative luminance", () => {
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
    assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
    assert.ok(Math.abs(relativeLuminance({ r: 128, g: 128, b: 128 }) - 0.2159) < 0.001);
  });

  it("samples the nav bar's scrim, clear of the button icons", () => {
    const png = decodePng(screencap(DARK_SCRIM));
    const navBar = parseNavigationBarFrame(text("dumpsys-window-3button-light.txt"));
    const region = navBarSampleRegion(navBar, png);
    assert.ok(region.right < 27 - 3, "the sample stays left of the first icon");
    assert.ok(region.top >= 227 && region.bottom <= 240);
    assert.ok(sampleLuminance(png, region) < 0.02);
    // An even-sized sample averages the two middle values.
    assert.ok(sampleLuminance(png, region, { cols: 2, rows: 1 }) < 0.02);
  });

  it("takes the mean of the two middle values of an even sample", () => {
    // A 4x1 image, black on the left half and white on the right: two
    // samples, one of each, so either middle value alone would be 0 or 1.
    const png = decodePng(
      encodePng({
        width: 4,
        height: 1,
        color: (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]),
      }),
    );
    const region = { left: 0, right: 4, top: 0, bottom: 1 };
    assert.equal(sampleLuminance(png, region, { cols: 2, rows: 1 }), 0.5);
  });

  it("rejects a screen width that isn't positive", () => {
    const png = decodePng(screencap(DARK_SCRIM));
    const navBar = parseNavigationBarFrame(text("dumpsys-window-3button-light.txt"));
    for (const width of [0, -1080, Number.NaN]) {
      assert.throws(() => navBarSampleRegion(navBar, png, width), /positive number/);
    }
  });
});

describe("fabAboveNavBar (M-01, Android)", () => {
  const threeButton = text("dumpsys-window-3button-light.txt");
  const gesture = text("dumpsys-window-gesture.txt");

  it("fails on 1.4.7: the FAB's bottom is 74px under a 3-button bar's top", () => {
    const result = fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), threeButton);
    assert.equal(result.pass, false);
    assert.equal(result.details.overlapPx, 74);
    assert.match(result.reason, /74px below the nav bar's top edge \(2274\)/);
  });

  it("passes once the FAB adds the bottom inset, in either nav mode", () => {
    assert.equal(
      fabAboveNavBar(tree("android-notebook-fab-3button-inset.json"), threeButton).pass,
      true,
    );
    assert.equal(
      fabAboveNavBar(tree("android-notebook-fab-gesture-inset.json"), gesture).pass,
      true,
    );
  });

  it("is strict in gesture mode too: a 20dp margin still reaches into the 24dp handle", () => {
    assert.equal(fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), gesture).pass, false);
    assert.equal(
      fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), gesture, { tolerance: 11 }).pass,
      true,
    );
  });

  it("measures nothing against a hidden nav bar", () => {
    const hidden = threeButton.replace(
      "type=navigationBars frame=[0,2274][1080,2400] visible=true",
      "type=navigationBars frame=[0,2274][1080,2400] visible=false",
    );
    const result = fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), hidden);
    assert.equal(result.measured, false);
    assert.match(result.reason, /hidden/);
  });

  it("measures nothing without a FAB, a nav bar, or in landscape", () => {
    const noFab = fabAboveNavBar(tree("android-offline-note-banner-clear.json"), threeButton);
    assert.match(noFab.reason, /no element/);
    assert.equal(noFab.measured, false);
    const noBar = fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), "");
    assert.match(noBar.reason, /no navigationBars/);
    assert.equal(noBar.measured, false);
    const side = "type=navigationBars frame=[2274,0][2400,1080] visible=true";
    const landscape = fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), side);
    assert.match(landscape.reason, /portrait/);
    assert.equal(landscape.measured, false);
    // A measured result carries no `measured` flag.
    assert.equal(
      fabAboveNavBar(tree("android-notebook-fab-no-inset.json"), threeButton).measured,
      undefined,
    );
  });
});

describe("fabAboveHomeIndicator (M-01, iOS)", () => {
  it("fails on 1.4.7: the FAB reaches 14pt into the 34pt home-indicator area", () => {
    const result = fabAboveHomeIndicator(tree("ios-notebook-fab-no-inset.json"));
    assert.equal(result.pass, false);
    assert.equal(result.details.overlapPt, 14);
    assert.equal(result.details.screenHeight, 874);
  });

  it("passes once the FAB adds the bottom inset", () => {
    assert.equal(fabAboveHomeIndicator(tree("ios-notebook-fab-inset.json")).pass, true);
  });

  it("takes an explicit screen height and inset, and fails without a FAB", () => {
    assert.equal(
      fabAboveHomeIndicator(tree("ios-notebook-fab-inset.json"), { screenHeight: 844 }).pass,
      false,
    );
    assert.equal(
      fabAboveHomeIndicator(tree("ios-notebook-fab-no-inset.json"), { safeBottom: 0 }).pass,
      true,
    );
    const noFab = fabAboveHomeIndicator(tree("ios-offline-note-banner-clear.json"));
    assert.equal(noFab.pass, false);
    assert.equal(noFab.measured, false);
  });
});

describe("bannerClearOfBack (M-03)", () => {
  it("fails on 1.4.7 (Android): the absolute banner's text covers Navigate up", () => {
    const result = bannerClearOfBack(tree("android-offline-note-banner-overlap.json"));
    assert.equal(result.pass, false);
    assert.equal(result.details.bannerBy, "text");
    assert.match(result.reason, /covers the back button by 52px/);
  });

  it("passes when the banner hangs straight off the header (Android)", () => {
    const result = bannerClearOfBack(tree("android-offline-note-banner-clear.json"));
    assert.equal(result.pass, true);
    assert.equal(result.details.bannerBy, "id");
    assert.equal(result.details.flush, true);
    assert.equal(result.details.pairs[0].gap, 0);
  });

  it("ignores the 3-button nav bar's own Back key (System UI)", () => {
    const root = tree("android-offline-note-banner-clear.json");
    root.children.push({
      attributes: {
        "resource-id": "com.android.systemui:id/back",
        accessibilityText: "Back",
        bounds: "[162,2274][350,2400]",
      },
    });
    const result = bannerClearOfBack(root);
    assert.equal(result.pass, true);
    assert.equal(result.details.pairs.length, 1);
    assert.equal(result.details.pairs[0].gap, 0);
  });

  it("fails a banner pushed above the header, with a blank strip under it", () => {
    const result = bannerClearOfBack(tree("android-offline-note-banner-above-header.json"));
    assert.equal(result.pass, false);
    assert.match(result.reason, /above the header/);
  });

  it("checks iOS's BackButton the same way", () => {
    assert.equal(bannerClearOfBack(tree("ios-offline-note-banner-overlap.json")).pass, false);
    const clear = bannerClearOfBack(tree("ios-offline-note-banner-clear.json"));
    assert.equal(clear.pass, true);
    assert.equal(clear.details.pairs[0].header.bottom, 116);
  });

  it("accepts a banner further below the header, and reports it isn't flush", () => {
    const root = tree("android-offline-note-banner-clear.json");
    const moved = JSON.parse(
      JSON.stringify(root).replace("[0,265][1080,370]", "[0,2000][1080,2105]"),
    );
    const result = bannerClearOfBack(moved);
    assert.equal(result.pass, true);
    assert.equal(result.details.flush, false);
  });

  it("measures nothing when either element is missing", () => {
    const noBanner = bannerClearOfBack(tree("android-notebook-fab-no-inset.json"));
    assert.match(noBanner.reason, /no offline banner/);
    assert.equal(noBanner.measured, false);
    const noBack = bannerClearOfBack(tree("android-offline-note-banner-clear.json"), {
      back: { accessibility: "Close" },
    });
    assert.match(noBack.reason, /no back button/);
    assert.equal(noBack.measured, false);
  });

  it("falls back to the back button's own bounds when no full-width header holds it", () => {
    const root = {
      attributes: { bounds: "[0,0][1080,2400]" },
      children: [
        { attributes: { accessibilityText: "Navigate up", bounds: "[0,118][147,265]" } },
        { attributes: { "resource-id": "offline-banner", bounds: "[0,265][1080,370]" } },
      ],
    };
    assert.equal(bannerClearOfBack(root).details.pairs[0].header.bottom, 265);
  });
});

describe("imageRendered (M-02)", () => {
  it("fails on a broken placeholder (icon plus alt text)", () => {
    const result = imageRendered(tree("android-note-image-broken.json"));
    assert.equal(result.pass, false);
    assert.match(result.reason, /1 of 1 images are under 100 tall/);
  });

  it("passes on a photo-sized image", () => {
    assert.equal(imageRendered(tree("android-note-image-rendered.json")).pass, true);
  });

  it("lets the E2E probe views decide when a build has them", () => {
    // A loaded image's probe plus a short caption that names the same file:
    // the caption alone would fail the alt-text reading.
    const withProbes = (probeId, probeLabel) => ({
      attributes: { bounds: "[0,0][1080,2400]" },
      children: [
        {
          attributes: {
            "resource-id": probeId,
            accessibilityText: probeLabel,
            bounds: "[0,400][5,1147]",
          },
        },
        { attributes: { text: "attachment-photo.jpg", bounds: "[42,1160][600,1200]" } },
      ],
    });
    const loaded = imageRendered(
      withProbes("editor-image-rendered", "Image shown: attachment-photo.jpg"),
    );
    assert.equal(loaded.pass, true, loaded.reason);
    assert.equal(loaded.details.by, "probe");
    const missing = imageRendered(
      withProbes("editor-image-missing", "Image not loaded: attachment-photo.jpg"),
    );
    assert.equal(missing.pass, false);
    assert.match(missing.reason, /1 of 1 images did not load/);
    // An anchored --alt matches the file name inside the probe's label.
    assert.equal(
      imageRendered(withProbes("editor-image-rendered", "Image shown: attachment-photo.jpg"), {
        alt: /^attachment-photo\.jpg$/,
      }).details.by,
      "probe",
    );
    // A probe for another file doesn't count: the caption is read instead.
    const other = imageRendered(withProbes("editor-image-rendered", "Image shown: other.png"), {
      alt: /^attachment-photo\.jpg$/,
    });
    assert.equal(other.details.by, "alt");
    assert.equal(other.pass, false);
  });

  it("measures nothing when no image matches, and honours alt and min height", () => {
    assert.equal(imageRendered(tree("android-notebook-fab-no-inset.json")).measured, false);
    const otherAlt = imageRendered(tree("android-note-image-rendered.json"), {
      alt: /^other\.png$/,
    });
    assert.equal(otherAlt.pass, false);
    assert.equal(otherAlt.measured, false);
    assert.equal(imageRendered(tree("android-note-image-broken.json")).measured, undefined);
    assert.equal(
      imageRendered(tree("android-note-image-broken.json"), { minHeight: 40 }).pass,
      true,
    );
  });
});

describe("navBarMatches (M-04)", () => {
  const darkShot = decodePng(screencap(DARK_SCRIM));
  const lightShot = decodePng(screencap(LIGHT_SCRIM));

  it("fails on 1.4.7 in in-app Dark: light scrim and LIGHT_NAVIGATION_BARS", () => {
    const result = navBarMatches(
      "dark",
      lightShot,
      text("dumpsys-window-3button-app-dark-light-bar.txt"),
    );
    assert.equal(result.pass, false);
    assert.match(result.reason, /luminance .* is not under 0\.25/);
    assert.match(result.reason, /apr=LIGHT_NAVIGATION_BARS/);
  });

  it("passes in Dark once the bar follows the theme", () => {
    const result = navBarMatches("dark", darkShot, text("dumpsys-window-3button-dark.txt"));
    assert.equal(result.pass, true, result.reason);
    assert.ok(result.details.luminance < 0.02);
  });

  it("passes in Light with a light scrim and the flag", () => {
    assert.equal(
      navBarMatches("light", lightShot, text("dumpsys-window-3button-light.txt")).pass,
      true,
    );
  });

  it("fails Light when either signal says dark", () => {
    const pixels = navBarMatches("light", darkShot, text("dumpsys-window-3button-light.txt"));
    assert.match(pixels.reason, /not over 0\.6/);
    const flag = navBarMatches("light", lightShot, text("dumpsys-window-3button-dark.txt"));
    assert.match(flag.reason, /doesn't ask for light nav-bar buttons/);
  });

  it("needs a nav bar, a Drafto window and the focus", () => {
    const noBar = navBarMatches("dark", darkShot, "");
    assert.match(noBar.reason, /no navigationBars/);
    const noWindow = navBarMatches("dark", darkShot, text("dumpsys-window-3button-dark.txt"), {
      pkg: "com.example",
    });
    assert.match(noWindow.reason, /no com\.example window/);
    const unfocused = navBarMatches("dark", darkShot, text("dumpsys-window-launcher-focused.txt"));
    assert.match(unfocused.reason, /not the focused/);
    const hidden = navBarMatches(
      "dark",
      darkShot,
      text("dumpsys-window-3button-dark.txt").replace(
        "type=navigationBars frame=[0,2274][1080,2400] visible=true",
        "type=navigationBars frame=[0,2274][1080,2400] visible=false",
      ),
    );
    assert.match(hidden.reason, /hidden/);
    for (const result of [noBar, noWindow, unfocused, hidden]) {
      assert.equal(result.measured, false);
    }
    assert.throws(() => navBarMatches("dim", darkShot, ""), /dark or light/);
  });

  it("measures only when the dumps before and after the screenshot agree", () => {
    const dark = text("dumpsys-window-3button-dark.txt");
    const settled = navBarMatches("dark", darkShot, dark, { dumpsysAfter: dark });
    assert.equal(settled.pass, true, settled.reason);
    // The window's flags changed between the two dumps: the bar was repainting.
    const repainting = navBarMatches("dark", darkShot, dark, {
      dumpsysAfter: text("dumpsys-window-3button-app-dark-light-bar.txt"),
    });
    assert.equal(repainting.measured, false);
    assert.match(repainting.reason, /changed while the screenshot was taken/);
    // So did the frame (3-button to gesture).
    const resized = navBarMatches("dark", darkShot, dark, {
      dumpsysAfter: text("dumpsys-window-gesture.txt"),
    });
    assert.equal(resized.measured, false);
    // Same name, frame and flags, but a new window: the activity was recreated.
    const recreated = navBarMatches("dark", darkShot, dark, {
      dumpsysAfter: dark.replaceAll("5f1e0b7", "6a2c9d1"),
    });
    assert.equal(recreated.measured, false);
    assert.match(recreated.reason, /changed while the screenshot was taken/);
  });

  it("measures nothing with the nav bar at the side (landscape)", () => {
    const side = text("dumpsys-window-3button-dark.txt").replace(
      "type=navigationBars frame=[0,2274][1080,2400]",
      "type=navigationBars frame=[0,0][126,1080]",
    );
    const result = navBarMatches("dark", darkShot, side);
    assert.equal(result.measured, false);
    assert.match(result.reason, /at the side; run the check in portrait/);
  });

  it("scales the frame to a screenshot of another size", () => {
    const full = decodePng(
      encodePng({
        width: 216,
        height: 480,
        color: (_x, y) => (y >= 455 ? [...DARK_SCRIM, 255] : [200, 200, 200, 255]),
      }),
    );
    assert.equal(navBarMatches("dark", full, text("dumpsys-window-3button-dark.txt")).pass, true);
    // Told the frame is in a 2160px-wide space, the sample lands higher up, on the light body.
    assert.equal(
      navBarMatches("dark", full, text("dumpsys-window-3button-dark.txt"), { screenWidth: 2160 })
        .pass,
      false,
    );
  });
});

describe("navModeReport", () => {
  it("reports the mode as evidence", () => {
    const report = navModeReport(
      text("dumpsys-window-3button-light.txt"),
      text("wm-density-420.txt"),
    );
    assert.equal(report.pass, true);
    assert.equal(report.details.mode, "three-button");
  });

  it("measures nothing when it can't tell the mode", () => {
    const unknown = navModeReport("", "");
    assert.equal(unknown.pass, false);
    assert.equal(unknown.measured, false);
    assert.equal(unknown.details.mode, "unknown");
    // A 36dp bar is neither a 3-button bar nor a gesture handle.
    const odd = navModeReport(
      "InsetsSource id=1 type=navigationBars frame=[0,2306][1080,2400] visible=true",
      "Physical density: 420",
    );
    assert.equal(odd.measured, false);
    assert.equal(odd.details.navBar.height, 94);
  });
});

describe("runCli", () => {
  const files = new Map();
  const read = (file) => {
    if (files.has(file)) return files.get(file);
    return readFileSync(fixturePath(file));
  };

  it("returns 0 and a JSON verdict on a pass, 1 on a fail", () => {
    const pass = runCli(
      [
        "fab-above-nav-bar",
        "--hierarchy",
        "android-notebook-fab-3button-inset.json",
        "--dumpsys",
        "dumpsys-window-3button-light.txt",
      ],
      read,
    );
    assert.equal(pass.code, 0);
    assert.equal(JSON.parse(pass.output).check, "fab-above-nav-bar");
    const fail = runCli(
      [
        "fab-above-nav-bar",
        "--hierarchy=android-notebook-fab-no-inset.json",
        "--dumpsys=dumpsys-window-3button-light.txt",
      ],
      read,
    );
    assert.equal(fail.code, 1);
    assert.equal(JSON.parse(fail.output).pass, false);
  });

  it("runs every check", () => {
    files.set("dark.png", screencap(DARK_SCRIM));
    files.set("light.png", screencap(LIGHT_SCRIM));
    const cases = [
      [
        [
          "fab-above-home-indicator",
          "--hierarchy",
          "ios-notebook-fab-inset.json",
          "--safe-bottom",
          "34",
        ],
        0,
      ],
      [
        [
          "fab-above-home-indicator",
          "--hierarchy",
          "ios-notebook-fab-no-inset.json",
          "--screen-height",
          "874",
        ],
        1,
      ],
      [["banner-clear-of-back", "--hierarchy", "android-offline-note-banner-clear.json"], 0],
      [
        [
          "banner-clear-of-back",
          "--hierarchy",
          "android-offline-note-banner-overlap.json",
          "--tolerance",
          "2",
        ],
        1,
      ],
      [
        [
          "banner-clear-of-back",
          "--hierarchy",
          "ios-offline-note-banner-clear.json",
          "--back-label",
          "Notes",
          "--banner-text",
          "You are offline",
          "--banner-id",
          "missing",
        ],
        0,
      ],
      [
        [
          "image-rendered",
          "--hierarchy",
          "android-note-image-rendered.json",
          "--alt",
          "attachment-photo\\.jpg",
        ],
        0,
      ],
      [
        ["image-rendered", "--hierarchy", "android-note-image-broken.json", "--min-height", "100"],
        1,
      ],
      [
        [
          "nav-bar-dark",
          "--screenshot",
          "dark.png",
          "--dumpsys",
          "dumpsys-window-3button-dark.txt",
        ],
        0,
      ],
      [
        [
          "nav-bar-light",
          "--screenshot",
          "dark.png",
          "--dumpsys",
          "dumpsys-window-3button-light.txt",
        ],
        1,
      ],
      [
        [
          "nav-bar-light",
          "--screenshot",
          "light.png",
          "--dumpsys",
          "dumpsys-window-3button-light.txt",
          "--screen-width",
          "1080",
        ],
        0,
      ],
      [
        ["nav-mode", "--dumpsys", "dumpsys-window-gesture.txt", "--density", "wm-density-420.txt"],
        0,
      ],
      [
        [
          "nav-bar-dark",
          "--screenshot",
          "dark.png",
          "--dumpsys",
          "dumpsys-window-3button-dark.txt",
          "--dumpsys-after",
          "dumpsys-window-3button-dark.txt",
        ],
        0,
      ],
      [["bounds", "--hierarchy", "android-notebook-fab-no-inset.json", "--id", "add"], 0],
      [
        ["bounds", "--hierarchy", "android-notebook-fab-no-inset.json", "--text", "Nothing here"],
        1,
      ],
    ];
    for (const [argv, code] of cases) {
      const result = runCli(argv, read);
      assert.equal(result.code, code, `${argv.join(" ")} → ${result.output}`);
      JSON.parse(result.output);
    }
  });

  it("returns 2, not 1, when the element to measure is absent", () => {
    files.set("dark.png", screencap(DARK_SCRIM));
    const cases = [
      [
        "fab-above-nav-bar",
        "--hierarchy",
        "android-offline-note-banner-clear.json",
        "--dumpsys",
        "dumpsys-window-3button-light.txt",
      ],
      ["fab-above-home-indicator", "--hierarchy", "ios-offline-note-banner-clear.json"],
      ["banner-clear-of-back", "--hierarchy", "android-notebook-fab-no-inset.json"],
      ["image-rendered", "--hierarchy", "android-notebook-fab-no-inset.json"],
      [
        "nav-bar-dark",
        "--screenshot",
        "dark.png",
        "--dumpsys",
        "dumpsys-window-launcher-focused.txt",
      ],
      [
        "nav-bar-dark",
        "--screenshot",
        "dark.png",
        "--dumpsys",
        "dumpsys-window-3button-dark.txt",
        "--dumpsys-after",
        "dumpsys-window-3button-app-dark-light-bar.txt",
      ],
      // Unmeasured (exit 2), not a measured fail (exit 1): no frame, no density.
      ["nav-mode", "--dumpsys", "wm-density-420.txt", "--density", "wm-density-420.txt"],
    ];
    for (const argv of cases) {
      const result = runCli(argv, read);
      assert.equal(result.code, 2, `${argv.join(" ")} → ${result.output}`);
      assert.equal(JSON.parse(result.output).measured, false);
    }
  });

  it("returns 2 on bad input", () => {
    assert.equal(runCli([], read).code, 2);
    assert.match(runCli(["sideways"], read).output, /Unknown check "sideways"/);
    assert.match(runCli(["image-rendered", "--hierarchy"], read).output, /Missing value/);
    const missing = runCli(["image-rendered"], read);
    assert.equal(missing.code, 2);
    assert.match(JSON.parse(missing.output).reason, /--hierarchy is required/);
    assert.match(
      runCli(
        ["image-rendered", "--hierarchy", "android-note-image-broken.json", "--min-height", "tall"],
        read,
      ).output,
      /must be a number/,
    );
    assert.match(
      runCli(["bounds", "--hierarchy", "android-note-image-broken.json"], read).output,
      /--id or --text/,
    );
    files.set("dark.png", screencap(DARK_SCRIM));
    const zeroWidth = runCli(
      [
        "nav-bar-dark",
        "--screenshot",
        "dark.png",
        "--dumpsys",
        "dumpsys-window-3button-dark.txt",
        "--screen-width",
        "0",
      ],
      read,
    );
    assert.equal(zeroWidth.code, 2);
    assert.match(JSON.parse(zeroWidth.output).reason, /positive number/);
    files.set("garbage.json", Buffer.from("not json"));
    assert.equal(runCli(["image-rendered", "--hierarchy", "garbage.json"], read).code, 2);
  });

  it("works as a script, with exit codes the runner can test", () => {
    const pass = spawnSync(
      process.execPath,
      [
        CLI,
        "banner-clear-of-back",
        "--hierarchy",
        fixturePath("android-offline-note-banner-clear.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).pass, true);
    const usage = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage:/);
    const fail = spawnSync(
      process.execPath,
      [CLI, "image-rendered", "--hierarchy", fixturePath("android-note-image-broken.json")],
      { encoding: "utf8" },
    );
    assert.equal(fail.status, 1);
  });
});
