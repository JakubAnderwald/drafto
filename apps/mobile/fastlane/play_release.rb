# frozen_string_literal: true

# Pure helpers for the Android (Google Play) lanes in ./Fastfile. They hold no
# fastlane state, so scripts/__tests__/play-release.test.mjs loads this file with
# plain `ruby` and checks them without fastlane, a Play account or a build.
module PlayRelease
  # Every Play track a release can sit on. Play needs a version code that is
  # unique across the whole app and higher than any code already uploaded, so
  # the next code is computed from all of them, not just the target track: the
  # internal track was at 87 while closed testing (alpha) held 82, so "alpha max
  # + 1" would have tried to reuse 83, which Play rejects.
  TRACKS = %w[internal alpha beta production].freeze

  # The tracks whose releases share the `mobile@` tag with iOS TestFlight. Their
  # testers (and, for production, the public) see every build, so the next
  # internal or TestFlight build's notes may start from one of their tags.
  SHARED_TAG_TRACKS = %w[internal production].freeze

  # The tag prefix every iOS and internal-track build uses. The notes generator
  # (apps/mobile/scripts/generate-release-notes.sh) and
  # scripts/comment-released-issues.mjs take their range start from it.
  SHARED_TAG_PREFIX = "mobile@"

  # Raised when a track's version codes could not be read. fastlane's
  # google_play_track_version_codes already returns [] for an empty, missing or
  # release-less track (supply maps Play's 404 trackEmpty / "Track not found" to
  # [], and in 2.242.0 a track with no `releases`, such as our open-testing
  # `beta`, too; 2.232.2 raised on it), so a raise here is a real failure:
  # network, a 5xx, auth.
  # Guessing that track is empty could reuse a code it holds, which Play only
  # rejects at upload, after the whole build.
  class TrackUnreadable < StandardError; end

  # Calls the block once per track and returns { track => [codes] }. The first
  # track the block raises for stops the lot with TrackUnreadable — no
  # exception counts as an empty track.
  def self.collect_version_codes(tracks = TRACKS)
    tracks.each_with_object({}) do |track, codes|
      codes[track] = Array(yield(track)).map(&:to_i)
    rescue StandardError => e
      raise TrackUnreadable,
            "Could not read version codes from Google Play track '#{track}' (#{e.message}). " \
            "Every track is needed to pick a version code Play has not used; retry once the " \
            "Play API answers."
    end
  end

  # One above the highest code on any track.
  def self.next_version_code(codes)
    (codes.values.flatten.max || 0) + 1
  end

  # The channel name in the customer-facing "Now live in <label>." comment and
  # the In Test build comment.
  def self.track_label(track, build)
    channel =
      case track
      when "production" then "Google Play"
      when "internal" then "Google Play internal track"
      when "alpha" then "Google Play closed testing"
      when "beta" then "Google Play open testing"
      else raise ArgumentError, "Unknown Google Play track: #{track.inspect}"
      end
    "#{channel} (build #{build})"
  end

  # Whether a release on this track posts "Now live" on the support issues it
  # closes. Closed testing (alpha) is a hand-picked tester list that the people
  # who reported an issue are generally not on, so the notice would point them
  # at a build they cannot install. An issue is announced once per platform
  # (scripts/lib/now-live.mjs), so an alpha notice would also suppress the
  # internal-track or production one they could act on.
  def self.announces_release?(track)
    %w[internal production].include?(track)
  end

  # The prefix of this track's release tag (`<prefix><version>+android.<code>`).
  # Closed and open testing get their own (`mobile-alpha@`, `mobile-beta@`):
  # a commit that shipped only there must not become the range start for the
  # next internal-track or TestFlight build's notes, or for its "Now live" walk,
  # since those testers never got it. `mobile-alpha@*` does not match the
  # `mobile@*` glob those readers list.
  def self.tag_prefix(track)
    SHARED_TAG_TRACKS.include?(track) ? SHARED_TAG_PREFIX : "mobile-#{track}@"
  end

  # The tag globs generate-release-notes.sh tries, in order, for this track's
  # notes: the newest tag not on HEAD from the first glob that has one starts
  # the range. Closed testing starts from its own previous release, and falls
  # back to the newest shared release before it has one.
  def self.notes_tag_globs(track)
    prefix = tag_prefix(track)
    globs = ["#{prefix}*"]
    globs << "#{SHARED_TAG_PREFIX}*" unless prefix == SHARED_TAG_PREFIX
    globs
  end

  # Whether the lane writes generated notes onto the track's releases. Not on
  # production: there they become the public listing's "What's new", and the
  # generator can only see commits since the last tagged build (usually the
  # last internal beta), not since the last production release, which no tag
  # marks apart. Production notes are written by hand in the Play Console.
  def self.posts_release_notes?(track)
    track != "production"
  end
end
