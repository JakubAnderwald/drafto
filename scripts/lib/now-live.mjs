// The "Now live in <track>" fingerprint shared by the Fastlane post-hook that
// posts it (scripts/comment-released-issues.mjs) and the nightly support runner
// that waits for it (scripts/lib/support-release.mjs, ADR-0042).
//
// Every announcement carries `<!-- now-live:<platform>:<build> -->`. The two
// sides must agree on that string exactly: the hook skips an issue that already
// has one for the platform, and the nightly treats its presence as "this
// platform's beta shipped" — so it lives here, once.
//
// Pure, no I/O.

// The platforms a "now live" notice is posted for, keyed by the store build.
// Android + iOS come from the mobile lane (`release:beta:all`), macOS from the
// desktop lane.
export const NOW_LIVE_PLATFORMS = Object.freeze(["android", "ios", "macos"]);

export function nowLiveFingerprint(platform, build) {
  return `<!-- now-live:${platform}:${build} -->`;
}

// Matches a notice for ANY build of the platform.
export function nowLivePrefix(platform) {
  return `<!-- now-live:${platform}:`;
}

// Has <platform> already been announced on this issue?
//
// Any build counts, not just the one being announced: a support fix is
// announced once per platform. Keying on the build alone let every later build
// whose tag range still covered the fix announce it again ("Now live in build
// 51", then 52, …).
//
// `since` (ISO-8601, optional) is the issue's latest close: only notices posted
// at or after it count, so an issue that is reopened and fixed again gets a new
// announcement for the new fix. Without it, any notice counts.
//
// `comments` is a list of {body, created_at|createdAt} (REST or gh --json shape).
export function hasNowLive(comments, platform, { since } = {}) {
  const prefix = nowLivePrefix(platform);
  const sinceMs = since ? Date.parse(since) : NaN;
  return (Array.isArray(comments) ? comments : []).some((c) => {
    if (typeof c?.body !== "string" || !c.body.includes(prefix)) return false;
    if (Number.isNaN(sinceMs)) return true;
    const at = Date.parse(c.created_at ?? c.createdAt ?? "");
    // A notice we can't date is counted: re-announcing is the worse failure.
    return Number.isNaN(at) || at >= sinceMs;
  });
}
