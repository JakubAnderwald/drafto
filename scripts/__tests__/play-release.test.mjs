import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAY_TRACKS,
  parseArgs,
  resolvePlayTrack,
} from "../../apps/mobile/scripts/post-release-notes.mjs";

// Google Play closed testing (the "alpha" track) next to the internal-track beta
// and production. PrimeTestLab 11035 asked for builds on the closed-testing
// channel; the Android lanes only knew internal and production, and computed
// the next version code from the target track alone — internal was at 87 while
// alpha held 82, so an alpha build would have reused code 83.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const read = (p) => readFileSync(resolve(REPO, p), "utf8");
const PLAY_RELEASE_RB = resolve(REPO, "apps/mobile/fastlane/play_release.rb");
const HAS_RUBY = spawnSync("ruby", ["-v"], { encoding: "utf8" }).status === 0;

// Runs a Ruby snippet with PlayRelease loaded and parses the JSON it prints.
function ruby(snippet) {
  const r = spawnSync("ruby", ["-rjson", "-e", `require ARGV[0]\n${snippet}`, PLAY_RELEASE_RB], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `ruby failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe(
  "PlayRelease (apps/mobile/fastlane/play_release.rb)",
  { skip: !HAS_RUBY && "no ruby" },
  () => {
    it("PrimeTestLab 11035 release: the next version code is one above the highest on ANY track", () => {
      const out = ruby(`
      codes = { "internal" => [87, 86], "alpha" => [82], "beta" => [], "production" => [80] }
      puts JSON.generate(PlayRelease.next_version_code(codes, {}))
    `);
      assert.equal(out, 88);
    });

    it("PrimeTestLab 11035 release: a track whose lookup raises counts as empty", () => {
      const out = ruby(`
      codes, errors = PlayRelease.collect_version_codes do |track|
        raise "Track not found" if track == "beta"
        { "internal" => [87], "alpha" => [82], "production" => [80] }.fetch(track)
      end
      puts JSON.generate(
        codes: codes, errors: errors.keys, next: PlayRelease.next_version_code(codes, errors)
      )
    `);
      assert.deepEqual(out.codes, { internal: [87], alpha: [82], beta: [], production: [80] });
      assert.deepEqual(out.errors, ["beta"]);
      assert.equal(out.next, 88);
    });

    it("PrimeTestLab 11035 release: asks every Play track, internal through production", () => {
      const out = ruby(`
      asked = []
      PlayRelease.collect_version_codes { |track| asked << track; [] }
      puts JSON.generate(asked)
    `);
      assert.deepEqual(out, ["internal", "alpha", "beta", "production"]);
      assert.deepEqual(out, PLAY_TRACKS, "post-release-notes.mjs must know the same tracks");
    });

    it("PrimeTestLab 11035 release: refuses to count from 0 when no track could be read", () => {
      const out = ruby(`
      codes, errors = PlayRelease.collect_version_codes { |_track| raise "401 Unauthorized" }
      begin
        PlayRelease.next_version_code(codes, errors)
        puts JSON.generate("no error")
      rescue PlayRelease::AllTracksUnreadable => e
        puts JSON.generate(e.message)
      end
    `);
      assert.match(out, /Could not read version codes from any Google Play track/);
    });

    it("PrimeTestLab 11035 release: starts at 1 for an app with no uploads anywhere", () => {
      const out = ruby(`
      codes, errors = PlayRelease.collect_version_codes { |_track| [] }
      puts JSON.generate(PlayRelease.next_version_code(codes, errors))
    `);
      assert.equal(out, 1);
    });

    it("PrimeTestLab 11035 release: labels each track for the customer-facing comments", () => {
      const out = ruby(`
      puts JSON.generate(%w[internal alpha beta production].map { |t| PlayRelease.track_label(t, 88) })
    `);
      assert.deepEqual(out, [
        "Google Play internal track (build 88)",
        "Google Play closed testing (build 88)",
        "Google Play open testing (build 88)",
        "Google Play (build 88)",
      ]);
    });

    it("PrimeTestLab 11035 release: closed testing does not announce 'Now live' to support reporters", () => {
      const out = ruby(`
      puts JSON.generate(%w[internal alpha production].map { |t| PlayRelease.announces_release?(t) })
    `);
      assert.deepEqual(out, [true, false, true]);
    });
  },
);

describe("mobile Fastfile alpha lane", () => {
  const src = read("apps/mobile/fastlane/Fastfile");
  const androidStart = src.indexOf("platform :android do");
  const iosStart = src.indexOf("platform :ios do");
  const android = src.slice(androidStart, iosStart);
  const buildAndSubmit = android.slice(android.indexOf("private_lane :build_and_submit"));

  it("PrimeTestLab 11035 release: declares a documented alpha lane that uploads to the alpha track", () => {
    // `fastlane lanes` only lists a lane when a desc immediately precedes it.
    assert.match(
      android,
      /desc "[^"]*closed testing[^"]*"\r?\n\s*lane :alpha do\r?\n\s*build_and_submit\(track: "alpha"\)/,
    );
  });

  it("PrimeTestLab 11035 release: loads the PlayRelease helpers", () => {
    assert.match(src, /^require File\.expand_path\("play_release\.rb", __dir__\)$/m);
  });

  it("PrimeTestLab 11035 release: computes the version code across all tracks, not the target track", () => {
    assert.match(buildAndSubmit, /next_code = next_play_version_code/);
    assert.ok(
      !/google_play_track_version_codes\(/.test(buildAndSubmit),
      "build_and_submit must not read one track's codes directly",
    );
    assert.match(src, /PlayRelease\.collect_version_codes do \|track\|/);
  });

  it("PrimeTestLab 11035 release: posts the notes to the track it uploaded to", () => {
    assert.match(
      buildAndSubmit,
      /post_release_notes\(platform: "android", max_chars: 500, track: track\)/,
    );
    assert.match(src, /cmd \+= \["--track", track\.to_s\]/);
  });

  it("PrimeTestLab 11035 release: gates the 'Now live' comment on the track but still tags", () => {
    const gate = buildAndSubmit.indexOf("if PlayRelease.announces_release?(track)");
    const comment = buildAndSubmit.indexOf("comment_released_issues(");
    const tag = buildAndSubmit.indexOf("tag_release(");
    assert.ok(gate !== -1, "comment_released_issues is not gated on the track");
    assert.ok(gate < comment, "the gate must come before the comment");
    assert.ok(tag > comment, "every Android lane must still tag its release");
    assert.match(buildAndSubmit, /track_label = PlayRelease\.track_label\(track, next_code\)/);
  });

  it("PrimeTestLab 11035 release: exposes the lane as pnpm release:alpha:android", () => {
    const pkg = JSON.parse(read("apps/mobile/package.json"));
    assert.equal(pkg.scripts["release:alpha:android"], "bundle exec fastlane android alpha");
  });

  it(
    "PrimeTestLab 11035 release: the Fastfile passes ruby -c",
    { skip: !HAS_RUBY && "no ruby" },
    () => {
      for (const p of ["apps/mobile/fastlane/Fastfile", PLAY_RELEASE_RB]) {
        const r = spawnSync("ruby", ["-c", resolve(REPO, p)], { encoding: "utf8" });
        assert.equal(r.status, 0, `${p}: ${r.stderr}`);
      }
    },
  );
});

describe("post-release-notes.mjs Play track", () => {
  it("PrimeTestLab 11035 release: parses --track", () => {
    assert.equal(
      parseArgs(["--platform", "android", "--notes", "x", "--track", "alpha"]).track,
      "alpha",
    );
    assert.equal(parseArgs(["--platform", "android", "--notes", "x"]).track, "");
  });

  it("PrimeTestLab 11035 release: --track wins, then GOOGLE_PLAY_TRACK, then internal", () => {
    assert.equal(resolvePlayTrack("alpha", { GOOGLE_PLAY_TRACK: "production" }), "alpha");
    assert.equal(resolvePlayTrack("", { GOOGLE_PLAY_TRACK: "production" }), "production");
    assert.equal(resolvePlayTrack("", {}), "internal");
  });

  it("PrimeTestLab 11035 release: rejects a track name Play would not recognise", () => {
    assert.throws(() => resolvePlayTrack("closed-testing", {}), /Unknown Google Play track/);
  });
});

// An alpha build usually ships a commit that the iOS TestFlight and Play
// internal lanes already tagged. The generator used to step back exactly one
// tag from HEAD, so with two tags on HEAD it took the second — also HEAD — and
// produced an empty range and no notes.
describe("generate-release-notes.sh (mobile) — several tags on HEAD", () => {
  let d;
  const script = resolve(REPO, "apps/mobile/scripts/generate-release-notes.sh");
  const g = (...args) => {
    const r = spawnSync("git", args, { cwd: d, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const c = (msg) => {
    mkdirSync(join(d, "apps/mobile"), { recursive: true });
    writeFileSync(join(d, "apps/mobile/f.txt"), msg);
    g("add", "-A");
    g("commit", "-m", msg, "--no-verify");
  };

  before(() => {
    d = mkdtempSync(join(tmpdir(), "drafto-relnotes-alpha-"));
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "T");
    c("fix: shipped in the previous release");
    g("tag", "mobile@1.6.0+android.87");
    c("feat: the change this release ships");
    g("tag", "mobile@1.7.0+ios.60");
    g("tag", "mobile@1.7.0+android.88");
  });

  after(() => d && rmSync(d, { recursive: true, force: true }));

  it("PrimeTestLab 11035 release: anchors on the newest tag that is not on HEAD", () => {
    const r = spawnSync("bash", [script], { cwd: d, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /the change this release ships/);
    assert.ok(!/shipped in the previous release/.test(r.stdout), r.stdout);
  });
});
